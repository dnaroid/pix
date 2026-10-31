import { createDesktopDraftModelRuntime, desktopToolsSuiteExtensionPath, type DesktopDraftModelRuntimeHandle } from "../acp/draft-model-runtime.js";
import { parseModelRef } from "../acp/pix-settings.js";
import { loadKnowledgeModelPreferences, type KnowledgeModelPreferences } from "./model-preferences.js";
import { bounded } from "../search/bounded.js";
import { compareKnowledge, type CheckCompletion } from "./comparison.js";
import { checkKnowledgeChunks, splitKnowledgeDocument } from "./chunks.js";
import { collectKnowledgeEvidence, type KnowledgeSearch, type KnowledgeSnapshot } from "./evidence.js";
import { createNativeKnowledgeSearch } from "./native-search.js";
import { parseKnowledgeCheckRequest } from "./request.js";
import { MAX_KNOWLEDGE_REVIEWED_CHARS, MAX_KNOWLEDGE_REVIEWED_PASSAGES,
  type KnowledgeCheckRequest, type KnowledgeCheckResult, type KnowledgeCitation, type KnowledgeReportLanguage } from "./contract.js";
import { loadKnowledgeReportLanguage } from "./preferences.js";
import { KnowledgeReportError, reportMessage } from "./report-language.js";
import { stripKnowledgeCheckStamp } from "./stamp.js";

export const KNOWLEDGE_CHECK_DEADLINE_MS = 120_000;

/** Reuse read/validated source text, never model-generated paths or background-only context. */
function reviewedPassages(snapshot: KnowledgeSnapshot): KnowledgeCitation[] | undefined {
  if (snapshot.evidence.length > MAX_KNOWLEDGE_REVIEWED_PASSAGES) return undefined;
  let total = 0;
  const passages: KnowledgeCitation[] = [];
  for (const source of snapshot.evidence) {
    const quote = source.text.replace(/\r\n?/gu, "\n");
    total += quote.length;
    const endLine = source.startLine + (quote.slice(0, -1).match(/\n/gu)?.length ?? 0);
    if (!quote.trim() || total > MAX_KNOWLEDGE_REVIEWED_CHARS
      || !Number.isSafeInteger(source.startLine) || source.startLine < 1 || !Number.isSafeInteger(endLine)) return undefined;
    passages.push({ path: source.path, quote, startLine: source.startLine, endLine });
  }
  return passages;
}

export interface KnowledgeCheckOptions {
  readonly bundledExtensionPath?: string;
  readonly agentDir?: string;
  readonly search?: KnowledgeSearch;
  readonly collect?: (request: KnowledgeCheckRequest, search: KnowledgeSearch, signal: AbortSignal, reportLanguage: KnowledgeReportLanguage) => Promise<KnowledgeSnapshot>;
  readonly loadReportLanguage?: () => Promise<KnowledgeReportLanguage>;
  readonly loadPreferences?: (cwd: string) => Promise<KnowledgeModelPreferences>;
  readonly createRuntime?: (cwd: string) => Promise<DesktopDraftModelRuntimeHandle>;
  readonly timeoutMs?: number;
  readonly warn?: (message: string) => void;
}

/** Stateless project-owned check. It neither writes a document nor changes search/model settings. */
export class KnowledgeCheckService {
  private readonly search: KnowledgeSearch;
  constructor(private readonly options: KnowledgeCheckOptions = {}) {
    this.search = options.search ?? createNativeKnowledgeSearch(options.bundledExtensionPath, options.agentDir);
  }

  async check(input: KnowledgeCheckRequest, signal: AbortSignal): Promise<KnowledgeCheckResult> {
    const request = parseKnowledgeCheckRequest(input);
    const body = stripKnowledgeCheckStamp(request.content);
    const chunks = splitKnowledgeDocument({ path: request.path, text: body });
    const comparisons = chunks.length * (chunks.length + 1) / 2;
    let handle: DesktopDraftModelRuntimeHandle | undefined;
    let reportLanguage: KnowledgeReportLanguage = "en";
    try {
      return await bounded(signal, this.options.timeoutMs ?? KNOWLEDGE_CHECK_DEADLINE_MS * comparisons, async owned => {
        reportLanguage = await (this.options.loadReportLanguage ?? loadKnowledgeReportLanguage)();
        owned.throwIfAborted();
        const preferences = await (this.options.loadPreferences ?? loadKnowledgeModelPreferences)(request.cwd);
        owned.throwIfAborted();
        const parsed = parseModelRef(preferences.modelRef);
        if (!parsed) throw new Error(reportMessage(reportLanguage, "selectModel"));
        const collect = (part: KnowledgeCheckRequest) => (this.options.collect ?? collectKnowledgeEvidence)(part, this.search, owned, reportLanguage);
        const snapshot = await collect(chunks.length > 1 ? { ...request, content: chunks[0]!.text } : request);
        owned.throwIfAborted();
        const retrievalNotices = [...snapshot.notices];
        if (!snapshot.evidence.length) retrievalNotices.push(reportMessage(reportLanguage, "noWikiEvidence"));
        const checkedSources = new Set(snapshot.evidence.map(source => source.path)).size;
        const base = { path: request.path, documentHash: snapshot.documentHash, modelRef: "", reportLanguage,
          checkedSources, conflicts: [], uncertainties: [], reviewedSources: [], notices: retrievalNotices,
          coverage: snapshot.coverage ?? { scope: "retrieved-passages" as const,
            checkedPassages: snapshot.evidence.length, candidateSources: checkedSources, excerptedSources: 0, limits: [] },
        };
        const acquired = await (this.options.createRuntime ?? (cwd => {
          const extension = desktopToolsSuiteExtensionPath(this.options);
          return createDesktopDraftModelRuntime({ cwd,
            ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
            ...(extension ? { additionalExtensionPaths: [extension] } : {}),
          });
        }))(request.cwd);
        if (owned.aborted) { acquired.dispose(); owned.throwIfAborted(); }
        handle = acquired;
        const runtime = acquired.modelRuntime;
        let model = runtime.getModel(parsed.provider, parsed.modelId);
        if (!model) {
          await runtime.refresh({ allowNetwork: true, providers: [parsed.provider], signal: owned });
          model = runtime.getModel(parsed.provider, parsed.modelId);
        }
        owned.throwIfAborted();
        if (!model) throw new Error(reportMessage(reportLanguage, "modelUnavailable"));
        const selectedModel = model;
        const maxTokens = Math.min(model.maxTokens > 0 ? model.maxTokens : 8192, 8192);
        const completePrompt: CheckCompletion = async (prompt, checkSignal) => {
          const message = await runtime.completeSimple(selectedModel, {
            systemPrompt: prompt.system,
            messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
          }, {
            signal: checkSignal, maxTokens, cacheRetention: "none", maxRetries: 0, maxRetryDelayMs: 0,
            timeoutMs: this.options.timeoutMs ?? KNOWLEDGE_CHECK_DEADLINE_MS,
            ...(preferences.thinking === "off" || selectedModel.reasoning === false ? {} : { reasoning: preferences.thinking }),
          });
          checkSignal.throwIfAborted();
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            throw new Error(message.errorMessage || reportMessage(reportLanguage, "modelFailed"));
          }
          if (message.stopReason === "length") throw new Error(reportMessage(reportLanguage, "modelOutputLimit"));
          return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
        };
        if (chunks.length > 1) return checkKnowledgeChunks({ request, body, chunks, firstSnapshot: snapshot,
          collect, complete: completePrompt, signal: owned, reportLanguage, modelRef: preferences.modelRef,
          ...(this.options.warn ? { warn: this.options.warn } : {}) });
        const comparison = await compareKnowledge(snapshot.document, snapshot.evidence, completePrompt, owned, reportLanguage);
        owned.throwIfAborted();
        if (!await snapshot.current(owned)) {
          this.options.warn?.("Wiki contradiction check invalidated by changed source content");
          return { ...base, modelRef: preferences.modelRef, status: "incomplete",
            notices: [...retrievalNotices, reportMessage(reportLanguage, "corpusChanged")] };
        }
        owned.throwIfAborted();
        const notices = [...new Set([...retrievalNotices, ...comparison.notices])];
        const reviewedSources = reviewedPassages(snapshot);
        if (!reviewedSources) notices.push(reportMessage(reportLanguage, "reviewedSourcesInvalid"));
        const complete = snapshot.evidence.length > 0 && snapshot.complete && comparison.complete && Boolean(reviewedSources);
        if (!complete) this.options.warn?.("Wiki contradiction check returned incomplete evidence or model output");
        return { ...base, modelRef: preferences.modelRef, conflicts: comparison.conflicts,
          uncertainties: comparison.uncertainties, reviewedSources: reviewedSources ?? [], notices,
          status: comparison.conflicts.length ? "conflicts" : complete ? "clear" : "incomplete" };
      });
    } catch (error) {
      if (error instanceof KnowledgeReportError) throw new Error(reportMessage(reportLanguage, error.reason));
      throw error;
    } finally {
      // Runs on cancellation/deadline even if a provider ignores its AbortSignal.
      handle?.dispose();
    }
  }
}
