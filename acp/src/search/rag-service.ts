import { readFile } from "node:fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDesktopDraftModelRuntime, type DesktopDraftModelRuntimeHandle } from "../acp/draft-model-runtime.js";
import { loadPixDefaultModel, type PixThinkingLevel } from "../acp/default-model.js";
import { parseModelRef } from "../acp/pix-settings.js";
import { desktopSearchConfigPath } from "./config.js";
import { bounded } from "./bounded.js";
import { collectRagEvidence, ragPrompt, type RagEvidence } from "./rag-evidence.js";
import type { RagRequest, RagResponse, RagProgress } from "./rag-contract.js";
import { validateRagCitations } from "./rag-citations.js";

export const RAG_DEADLINE_MS = 90_000;
const MAX_RAG_CHARS = 32_000;
const RAG_MAX_TOKENS = 8_192;
const THINKING = new Set<PixThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface RagModelPreferences {
  readonly modelRef: string;
  readonly thinking: PixThinkingLevel;
}
export interface RagServiceOptions {
  readonly loadPreferences?: (cwd: string) => Promise<RagModelPreferences>;
  readonly collect?: (request: RagRequest, signal: AbortSignal) => Promise<RagEvidence[]>;
  readonly createRuntime?: (cwd: string) => Promise<DesktopDraftModelRuntimeHandle>;
}

/** User-global Desktop RAG model settings. No project-supplied model overrides. */
export async function loadRagPreferences(cwd: string, path = desktopSearchConfigPath()): Promise<RagModelPreferences> {
  let config: unknown;
  try { config = parseJsonc(await readFile(path, "utf8")); }
  catch { config = {}; }
  const settings = isObject(config) && isObject(config.search) ? config.search : {};
  const chosen = typeof settings.ragModelRef === "string" ? settings.ragModelRef.trim() : "";
  const defaultModel = loadPixDefaultModel(cwd);
  const defaultRef = defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : "";
  const modelRef = chosen || defaultRef;
  if (!modelRef || !parseModelRef(modelRef)) throw new Error("RAG model unavailable. Select a model in Desktop Settings.");
  const effort = typeof settings.ragThinking === "string" && THINKING.has(settings.ragThinking as PixThinkingLevel)
    ? settings.ragThinking as PixThinkingLevel : "medium";
  return { modelRef, thinking: effort };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalText(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.content)) return "";
  return message.content.flatMap(part => isObject(part) && part.type === "text" && typeof part.text === "string"
    ? [part.text] : []).join("");
}

/** Isolated, stateless RAG generation; does not create or modify Pi sessions. */
export class DesktopRagService {
  constructor(private readonly options: RagServiceOptions = {}) {}

  async generate(request: RagRequest, progress: (update: RagProgress) => Promise<void>, signal: AbortSignal): Promise<RagResponse> {
    return bounded(signal, RAG_DEADLINE_MS, async owned => {
      const evidence = await (this.options.collect ?? collectRagEvidence)(request, owned);
      owned.throwIfAborted();
      const sourceIds = evidence.map(source => source.id);
      if(evidence.some(source=>source.incomplete)) throw new Error("Session context exceeds the RAG budget. Narrow the question/session; a final decision cannot be established safely.");
      await progress({ sourceIds });
      owned.throwIfAborted();
      if (!evidence.length) return { answer: "No relevant project evidence found. Try another query or include additional sources.", modelRef: "", sourceIds };
      const config = await (this.options.loadPreferences ?? loadRagPreferences)(request.cwd);
      const parsed = parseModelRef(config.modelRef);
      if (!parsed) throw new Error("RAG model unavailable");
      const handle = await (this.options.createRuntime ?? (cwd => createDesktopDraftModelRuntime({ cwd })))(request.cwd);
      try {
        const runtime: ModelRuntime = handle.modelRuntime;
        let model = runtime.getModel(parsed.provider, parsed.modelId);
        if (!model) {
          await runtime.refresh({ allowNetwork: true, providers: [parsed.provider], signal: owned });
          model = runtime.getModel(parsed.provider, parsed.modelId);
        }
        if (!model) throw new Error("RAG model unavailable");
        const prompt = ragPrompt(request.query, evidence);
        const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, RAG_MAX_TOKENS) : RAG_MAX_TOKENS;
        const modelRef = `${parsed.provider}/${parsed.modelId}`;
        const stream = runtime.streamSimple({ ...model, maxTokens }, {
          systemPrompt: prompt.system,
          messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
        }, {
          signal: owned,
          ...(config.thinking === "off" || model.reasoning === false ? {} : { reasoning: config.thinking }),
          cacheRetention: "none",
          maxRetryDelayMs: 0,
          maxRetries: 0,
          timeoutMs: RAG_DEADLINE_MS,
          maxTokens,
        });
        let answer = "";
        for await (const event of stream) {
          owned.throwIfAborted();
          if (event.type === "error") throw new Error(event.error.errorMessage || "RAG generation failed (provider returned no error details)");
          const delta = event.type === "text_delta" ? event.delta
            : event.type === "done" && !answer ? finalText(event.message) : "";
          if (!delta) continue;
          if(answer.length + delta.length > MAX_RAG_CHARS) throw new Error("RAG answer exceeded the output budget");
          const permitted = delta;
          if (!permitted) break;
          answer += permitted;
        }
        owned.throwIfAborted();
        if (!answer.trim()) throw new Error("RAG generation failed: model returned an empty answer");
        validateRagCitations(answer,sourceIds.length);
        for(const source of evidence) {
          if(source.current && !await source.current(owned)) throw new Error("Session changed during RAG generation; run the question again");
        }
        for(let offset=0;offset<answer.length;offset+=1500) {
          owned.throwIfAborted(); await progress({text:answer.slice(offset,offset+1500)});
        }
        return { answer, modelRef, sourceIds };
      } finally { handle.dispose(); }
    });
  }
}
