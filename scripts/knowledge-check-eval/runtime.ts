import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDesktopDraftModelRuntime } from "../../acp/src/acp/draft-model-runtime.js";
import { parseModelRef } from "../../acp/src/acp/pix-settings.js";
import { bounded } from "../../acp/src/search/bounded.js";
import type { CheckCompletion } from "../../acp/src/knowledge/comparison.js";

export type KnowledgeEvalThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface KnowledgeEvalRuntimeOptions {
  readonly cwd: string;
  readonly modelRef: string;
  readonly thinking: KnowledgeEvalThinking;
  readonly timeoutMs: number;
  readonly maxCalls: number;
  /** The caller creates a unique, owned eval directory under the project's artifacts. */
  readonly output: string;
  readonly signal: AbortSignal;
}

export interface EvalCallRecord {
  readonly id: number;
  readonly caseId: string;
  readonly prompt: { readonly system: string; readonly user: string };
  readonly rawText: string;
  readonly stopReason?: string;
  readonly elapsedMs: number;
  readonly usage?: unknown;
  readonly error?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** The same sessionless SDK path and completion settings as the production Wiki judge. */
export async function openKnowledgeEvalRuntime(options: KnowledgeEvalRuntimeOptions) {
  options.signal.throwIfAborted();
  if (/^(1|true|yes)$/iu.test((process.env.PI_OFFLINE ?? "").trim())) throw new Error("PI_OFFLINE forbids live evaluation requests.");
  const parsed = parseModelRef(options.modelRef);
  if (!parsed) throw new Error("Pass an explicit provider/model for the live Wiki evaluation.");
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 256) {
    throw new Error("The evaluation requires a bounded request budget from 1 to 256.");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) {
    throw new Error("The evaluation requires a request timeout from 1 to 600000 milliseconds.");
  }
  const requestsDirectory = join(resolve(options.output), "requests");
  await mkdir(requestsDirectory, { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  const owner = new AbortController();
  const signal = AbortSignal.any([options.signal, owner.signal]);
  const handle = await bounded(signal, options.timeoutMs, async owned => {
    const acquired = await createDesktopDraftModelRuntime({ cwd: options.cwd });
    if (owned.aborted) { acquired.dispose(); owned.throwIfAborted(); }
    return acquired;
  });

  try {
    const runtime = handle.modelRuntime;
    let model = runtime.getModel(parsed.provider, parsed.modelId);
    if (!model) {
      await bounded(signal, options.timeoutMs, owned => runtime.refresh({
        allowNetwork: true, providers: [parsed.provider], signal: owned,
      }));
      model = runtime.getModel(parsed.provider, parsed.modelId);
    }
    signal.throwIfAborted();
    if (!model) throw new Error(`Requested evaluation model is unavailable: ${options.modelRef}`);
    const selectedModel = model;
    const maxTokens = Math.min(model.maxTokens > 0 ? model.maxTokens : 8192, 8192);
    const metadata = {
      requestedModelRef: options.modelRef,
      modelRef: `${model.provider}/${model.id}`,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      contextWindow: model.contextWindow,
      modelMaxTokens: model.maxTokens,
      maxTokens,
      reasoning: model.reasoning,
      thinking: options.thinking,
      timeoutMs: options.timeoutMs,
      maxCalls: options.maxCalls,
      maxRetries: 0,
    };
    const records: EvalCallRecord[] = [];
    let sequence = 0, active = false, disposed = false;
    let stopReason: string | undefined;

    async function record(value: EvalCallRecord): Promise<void> {
      records.push(value);
      // Unique IDs and exclusive creation never overwrite an earlier raw answer.
      const path = join(requestsDirectory, `call-${String(value.id).padStart(4, "0")}.json`);
      await writeFile(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    }

    return {
      metadata,
      records,
      get stopReason(): string | undefined { return stopReason; },
      complete(caseId: string): CheckCompletion {
        if (!caseId.trim() || caseId.length > 512) throw new Error("A bounded evaluation case ID is required.");
        return async (prompt, checkSignal) => {
          const current = AbortSignal.any([signal, checkSignal]);
          current.throwIfAborted();
          if (disposed) throw new Error("The evaluation runtime is disposed.");
          if (stopReason) throw new Error(`The evaluation runtime stopped: ${stopReason}`);
          if (active) {
            stopReason = "Overlapping model requests are not allowed in this evaluation.";
            owner.abort(new Error(stopReason));
            throw new Error(stopReason);
          }
          if (sequence >= options.maxCalls) {
            stopReason = "The evaluation model-call budget is exhausted.";
            throw new Error(stopReason);
          }
          active = true;
          const id = ++sequence, started = performance.now();
          let rawText = "", responseStopReason: string | undefined, usage: unknown;
          let failure: unknown, failed = false;
          try {
            const message = await bounded(current, options.timeoutMs, owned => runtime.completeSimple(selectedModel, {
              systemPrompt: prompt.system,
              messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
            }, {
              signal: owned, maxTokens, cacheRetention: "none", maxRetries: 0, maxRetryDelayMs: 0,
              timeoutMs: options.timeoutMs,
              ...(options.thinking === "off" || selectedModel.reasoning === false ? {} : { reasoning: options.thinking }),
            }));
            // Persist only user-visible text and usage, never provider reasoning, auth or headers.
            rawText = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
            responseStopReason = message.stopReason;
            usage = message.usage;
            current.throwIfAborted();
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              throw new Error(message.errorMessage || "The evaluation model request failed.");
            }
            if (message.stopReason === "length") throw new Error("The evaluation model exhausted its output limit.");
          } catch (error) {
            failed = true;
            failure = error;
            stopReason ??= errorText(error);
            // A timed-out provider may settle late. No subsequent request may
            // start on this handle even if the provider ignores cancellation.
            owner.abort(error);
          } finally {
            const value: EvalCallRecord = {
              id, caseId, prompt: { system: prompt.system, user: prompt.user }, rawText,
              ...(responseStopReason ? { stopReason: responseStopReason } : {}),
              elapsedMs: Math.max(0, Math.round(performance.now() - started)),
              ...(usage !== undefined ? { usage } : {}),
              ...(failed ? { error: errorText(failure) } : {}),
            };
            try { await record(value); }
            catch (error) {
              stopReason ??= `Could not retain the evaluation response: ${errorText(error)}`;
              owner.abort(error);
              if (!failed) failure = error;
              failed = true;
            } finally { active = false; }
          }
          if (failed) throw failure;
          return rawText;
        };
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        owner.abort(new Error("The evaluation runtime was disposed."));
        handle.dispose();
      },
    };
  } catch (error) {
    owner.abort(error);
    handle.dispose();
    throw error;
  }
}
