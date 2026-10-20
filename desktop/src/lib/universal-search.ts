import type { LocalSearchHit, SearchQueryRequest, SearchQueryResponse, SearchSetting, SearchStatus, SemanticTasksResponse } from "../../../acp/src/search/contract";
import type { GitHistoryEntry } from "./git-workflow";
import type { ProjectTaskDocument } from "./project-tasks";
import { searchProjectPlans, searchProjectTasks, searchRecentCommits, type TaskSearchHit, type CommitSearchHit } from "./project-search";
import { rankSearchHits } from "./search-relevance";
import { normalizeSearchConcepts, patchSearchTerm } from "./search-query";
import { pendingSearchNotice, runSearchSource } from "./search-source-deadline";
import type { CommitSearchResponse, CommitSearchHit as HybridCommitHit } from "../../../acp/src/search/contract";
import type { NativeSearchHit, NativeSearchRequest, NativeSearchResponse } from "../../../external/pi-tools-suite/src/project-search/native-contract";
import type { SourcePolicy } from "./search-source-selection";
import type { FederatedSource, FederatedRerankContext, FederatedRerankRequest, FederatedRerankResponse, NativeRerankContext } from "../../../external/pi-tools-suite/src/project-search/native-contract";
import { selectFederatedCandidates, applyFederatedOrder } from "../../../external/pi-tools-suite/src/project-search/federation-ranking.mjs";
import { requestFederatedSearch } from "./search-federated-request";

export type SearchKind = "settings" | "sessions" | "tasks" | "commits" | "code" | "knowledge";
export const SEARCH_KINDS: readonly SearchKind[] = ["settings", "sessions", "tasks", "commits", "code", "knowledge"];
export const SEARCH_LABELS: Record<SearchKind, string> = { settings: "Settings", sessions: "Sessions", tasks: "Tasks", commits: "Commits", code: "Code", knowledge: "Knowledge" };
export type SearchHit = LocalSearchHit | NativeSearchHit | TaskSearchHit | CommitSearchHit | HybridCommitHit;
export interface SearchSources {
  prepareRerank?: (workspace: string, sources: FederatedSource[], signal: AbortSignal) => Promise<{ context?: FederatedRerankContext }>;
  rerank?: (workspace: string, request: FederatedRerankRequest, signal: AbortSignal) => Promise<FederatedRerankResponse>;
  selection?: (workspace: string, signal: AbortSignal) => Promise<SourcePolicy>;
  repository?: (workspace: string, request: NativeSearchRequest, signal: AbortSignal) => Promise<NativeSearchResponse>;
  local?: (request: SearchQueryRequest, signal: AbortSignal) => Promise<SearchQueryResponse>;
  tasks?: (workspace: string) => Promise<ProjectTaskDocument>;
  taskAttachmentNames?: (workspace: string) => Promise<Readonly<Record<string, readonly string[]>>>;
  /** Saved plan paths; plans are searched as part of the Tasks source. */
  plans?: (workspace: string) => Promise<readonly string[]>;
  taskSemantic?: (workspace: string, query: string, signal: AbortSignal) => Promise<SemanticTasksResponse>;
  commits?: (workspace: string, query: string) => Promise<GitHistoryEntry[]>;
  commitHybrid?: (workspace: string, query: string, signal: AbortSignal) => Promise<CommitSearchResponse>;
}
export interface UnifiedSearchResult {
  results: SearchHit[];
  status?: SearchStatus;
  notices: string[];
  pendingSources?: string[];
}

function settingsFallback(settings: readonly SearchSetting[], query: string): LocalSearchHit[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return settings.flatMap(field => {
    const text = `${field.label} ${field.description} ${field.synonyms.join(" ")}`.toLocaleLowerCase();
    const score = words.filter(word => text.includes(word)).length / words.length;
    return score ? [{ kind: "settings" as const, id: `settings:${field.id}`, fieldId: field.id, section: field.section, title: field.label, snippet: field.description, score }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}

/** Bound provider/CLI diagnostics and avoid displaying common credential forms. */
function searchErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const safe = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[redacted]")
    .replace(/\b((?:[a-z_]*api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\s+/gu, " ").trim();
  return safe.length > 600 ? `${safe.slice(0, 600)}…` : safe || "Unknown error";
}

export async function queryUniversalSearch(
  sources: SearchSources,
  workspace: string,
  query: string,
  types: readonly SearchKind[],
  settings: readonly SearchSetting[],
  signal: AbortSignal,
  onUpdate?: (result: UnifiedSearchResult) => void,
): Promise<UnifiedSearchResult> {
  const result: UnifiedSearchResult = { results: [], notices: [] };
  if (!query.trim() || !types.length || signal.aborted) return result;
  try {
    let policy: SourcePolicy | undefined;
    if (sources.selection) {
      const selection = sources.selection;
      const owner = new AbortController();
      const outcome = await runSearchSource(AbortSignal.any([signal, owner.signal]), async owned => {
        const next = await selection(workspace, owned);
        if (!owned.aborted) policy = next;
      }, () => owner.abort(new Error("Search source selection timed out")), () => {}, 5000);
      if (outcome !== "completed" || !policy || policy.error) throw new Error("Search source selection unavailable");
    }
    const enabled = policy?.enabled ?? { settings: true, code: true, knowledge: false, sessions: false, tasks: false, commits: false };
    types = types.filter(kind => enabled[kind]);
    if (!types.length) result.notices.push("Selected search sources are disabled for this project.");
  } catch {
    return { results: [], notices: signal.aborted ? [] : ["Search source selection unavailable; no sources were searched."] };
  }
  if (signal.aborted) return result;
  const patchOnly = patchSearchTerm(query) !== undefined;
  if (patchOnly) types = types.filter(kind => kind === "commits");
  if (!types.length) return result;
  let rerankContext: FederatedRerankContext | undefined;
  const nativeContext: NativeRerankContext = {};
  const federatedTypes = types.filter((kind): kind is FederatedSource => kind !== "settings");
  if (sources.prepareRerank && sources.rerank && workspace && federatedTypes.length) {
    try {
      const prepare = sources.prepareRerank;
      const prepared = await requestFederatedSearch(signal, owned => prepare(workspace, federatedTypes, owned), 4000);
      if (!signal.aborted) rerankContext = prepared.context;
    } catch {
      if (!signal.aborted) result.notices.push("Search reranking context unavailable; original ranking retained.");
    }
  }
  if (signal.aborted) return { results: [], notices: [] };
  const indexQuery = normalizeSearchConcepts(query);
  const localTypes = types.filter((kind): kind is "settings" | "sessions" => kind === "settings" || kind === "sessions");
  const groups = new Map<string, SearchHit[]>();
  const pending = new Map<string, string>();
  let latest = result;
  let finalRanked: SearchHit[] | undefined;
  let completedSources = 0;
  let reranking: Promise<void> | undefined;
  const localRanked = (limit = 60) => rankSearchHits([
    ...(groups.get("commits-hybrid") ?? []),
    ...[...groups].filter(([group]) => group !== "commits-hybrid").flatMap(([, hits]) => hits),
  ], query, settings, Boolean(result.status?.enabled && result.status.keyAvailable), false, limit);
  const emit = () => {
    if (signal.aborted) return;
    latest = {
      ...result,
      results: finalRanked ?? localRanked(),
      notices: [...result.notices, ...pending.values()],
      ...(pending.size ? { pendingSources: [...pending.keys()] } : {}),
    };
    onUpdate?.(latest);
  };
  const finishRerank = async () => {
    if (signal.aborted || !rerankContext || !sources.rerank) return;
    const local = localRanked(1000);
    const candidates: SearchHit[] = selectFederatedCandidates(local);
    if (!candidates.length) return;
    try {
      const request: FederatedRerankRequest = { query, context: rerankContext, nativeContext,
        candidates: candidates.filter((hit): hit is Exclude<SearchHit, { kind: "settings" }> => hit.kind !== "settings")
          .map(hit => ({ kind: hit.kind, id: hit.id, title: hit.title.slice(0, 512), snippet: hit.snippet.slice(0, 4096), score: hit.score,
            ...((hit.kind === "code" || hit.kind === "knowledge") ? { path: hit.path, content: hit.content?.slice(0, 7500) } : {}) })),
      };
      const rerank = sources.rerank;
      const response = await requestFederatedSearch(signal, owned => rerank(workspace, request, owned), 4500);
      if (signal.aborted) return;
      const ordered: SearchHit[] | undefined = applyFederatedOrder(candidates, response.order);
      if (ordered) {
        // Settings stay in their local slots and are never sent to the provider.
        let index = 0;
        finalRanked = local.filter(hit => hit.kind === "settings" || candidates.includes(hit))
          .map(hit => hit.kind === "settings" ? hit : ordered[index++]!).slice(0, 60);
        if (local.filter(hit => hit.kind !== "settings").length > candidates.length) result.notices.push("Search reranking candidate limit reached; results are partial.");
      }
      result.notices.push(...response.notices);
    } catch {
      if (!signal.aborted) result.notices.push("Search reranking unavailable; original ranking retained.");
    }
    emit();
  };
  const bounded = (label: string, operation: (signal: AbortSignal) => Promise<void>, fallback?: () => void) =>
    runSearchSource(signal, operation, () => {
      fallback?.();
      pending.set(label, pendingSearchNotice(label));
      emit();
    }, error => {
      pending.delete(label);
      if (error) result.notices.push(`${label} search failed: ${searchErrorDetail(error)}`);
      emit();
      if (++completedSources === 6) reranking = finishRerank();
    });
  await Promise.all([
    bounded("Tasks", async signal => {
      if (!types.includes("tasks") || !workspace) return;
      try {
        if (!sources.tasks) throw new Error("Task source unavailable");
        const metadata = sources.taskAttachmentNames?.(workspace).catch(() => ({}));
        const planPaths = sources.plans?.(workspace).catch(() => [] as readonly string[]);
        const tasks = await sources.tasks(workspace);
        const attachmentNames = metadata ? await metadata : {};
        const plans = planPaths ? await planPaths : [];
        if (!signal.aborted) groups.set("tasks", [...searchProjectTasks(tasks, query, attachmentNames), ...searchProjectPlans(plans, query)]);
      } catch (error) {
        if (!signal.aborted) result.notices.push(`Tasks search failed: ${searchErrorDetail(error)}`);
      }
    }),
    bounded("Semantic Tasks", async signal => {
      if (!types.includes("tasks") || !workspace || !sources.taskSemantic) return;
      try {
        const response = await sources.taskSemantic(workspace, query, signal);
        if (signal.aborted) return;
        groups.set("task-semantic", [...response.results]);
        if (response.pendingIndex) result.notices.push("Semantic Tasks: indexing is incomplete. Use Search indexes to continue; searching does not index task documents.");
      } catch (error) {
        if (!signal.aborted) result.notices.push(`Semantic Tasks search failed: ${searchErrorDetail(error)}. Local task matches remain available.`);
      }
    }),
    bounded("Commits", async signal => {
      if (!types.includes("commits") || !workspace || patchOnly) return;
      try {
        if (!sources.commits) throw new Error("Commit source unavailable");
        const commits = await sources.commits(workspace, query);
        if (!signal.aborted) groups.set("commits", searchRecentCommits(commits, query));
      } catch (error) {
        if (!signal.aborted) result.notices.push(`Commits search failed: ${searchErrorDetail(error)}`);
      }
    }),
    bounded(patchOnly ? "Git patches" : "Semantic commits", async signal => {
      if (!types.includes("commits") || signal.aborted) return;
      if (!sources.commitHybrid) {
        if (patchOnly) result.notices.push("Git patch search requires a connected ACP backend.");
        return;
      }
      try {
        const response = await sources.commitHybrid(workspace, query, signal);
        if (signal.aborted) return;
        groups.set("commits-hybrid", [...response.results]);
        result.notices.push(...response.notices);
      } catch {
        if (!signal.aborted) result.notices.push(patchOnly
          ? "Git patch search unavailable; try again."
          : "Semantic commit search unavailable; local commit search remains available.");
      }
    }),
    bounded(localTypes.map(kind => SEARCH_LABELS[kind]).join(" / "), async signal => {
      if (!localTypes.length) return;
      if (!sources.local) {
        if (types.includes("settings")) groups.set("local", settingsFallback(settings, query));
        if (types.includes("sessions")) result.notices.push("Session title search is unavailable: no backend connection is available to search.");
        return;
      }
      try {
        const response = await sources.local({ cwd: workspace, query, types: localTypes, settings, limit: 40 }, signal);
        if (signal.aborted) return;
        result.status = response.status;
        groups.set("local", response.results.filter(hit => types.includes(hit.kind)));
      } catch (error) {
        if (signal.aborted) return;
        if (types.includes("settings")) groups.set("local", settingsFallback(settings, query));
        result.notices.push(`${localTypes.map(kind => SEARCH_LABELS[kind]).join(" / ")} search failed: ${searchErrorDetail(error)}`);
      }
    }, () => { if (types.includes("settings")) groups.set("local", settingsFallback(settings, query)); }),
    bounded("Code / Knowledge", async signal => {
      const indexTypes = types.filter((kind): kind is "code" | "knowledge" => kind === "code" || kind === "knowledge");
      if (!indexTypes.length || !workspace) return;
      if (sources.repository) {
        try {
          const response = await sources.repository(workspace, { query: indexQuery, sources: indexTypes, mode: "lexical", limit: rerankContext ? 100 : 30, includeContent: true,
            ...(sources.rerank ? { skipRerank: true } : {}) }, signal);
          if (signal.aborted) return;
          if (!response.status.generation && !response.status.complete) throw new Error("Native snapshot unavailable");
          Object.assign(nativeContext, response.rerankContext);
          for (const kind of indexTypes) groups.set(kind, response.hits.filter(hit => hit.kind === kind).slice(0, rerankContext ? 100 : 15));
          result.notices.push(...response.notices);
          emit();
          if (response.status.semanticEnabled || (response.status.rerankerEnabled && !sources.rerank)) {
            try {
              const enriched = await sources.repository(workspace, { query: indexQuery, sources: indexTypes,
                mode: "hybrid", limit: rerankContext ? 100 : 30, includeContent: true,
                ...(sources.rerank ? { skipRerank: true } : {}) }, signal);
              if (signal.aborted) return;
              if (enriched.status.generation || enriched.status.complete) {
                for (const kind of indexTypes) groups.set(kind, enriched.hits.filter(hit => hit.kind === kind).slice(0, rerankContext ? 100 : 15));
                for (const kind of indexTypes) delete nativeContext[kind];
                Object.assign(nativeContext, enriched.rerankContext);
              }
              result.notices.push(...enriched.notices);
              emit();
            } catch {
              if (!signal.aborted) result.notices.push("Code / Knowledge semantic search unavailable; local matches retained.");
            }
          }
          return;
        } catch {
          if (signal.aborted) return;
          result.notices.push("Native Code/Knowledge search is unavailable. Retry the search or inspect Search indexes for diagnostics.");
        }
      }
    }),
  ]);
  await reranking;
  if (signal.aborted) return { ...result, results: [], notices: [] };
  emit();
  return latest;
}
