import type { LocalSearchHit, SearchQueryRequest, SearchQueryResponse, SearchSetting, SearchStatus, SemanticTasksResponse } from "../../../acp/src/search/contract";
import type { GitHistoryEntry } from "./git-workflow";
import type { ProjectTaskDocument } from "./project-tasks";
import { searchProjectTasks, searchRecentCommits, type TaskSearchHit, type CommitSearchHit } from "./project-search";
import { rankSearchHits } from "./search-relevance";
import { normalizeSearchConcepts, patchSearchTerm } from "./search-query";
import { pendingSearchNotice, runSearchSource } from "./search-source-deadline";
import type { CommitSearchResponse, CommitSearchHit as HybridCommitHit } from "../../../acp/src/search/contract";
import type { NativeSearchHit, NativeSearchRequest, NativeSearchResponse } from "../../../external/pi-tools-suite/src/project-search/native-contract";

export type SearchKind = "settings" | "sessions" | "tasks" | "commits" | "code" | "knowledge";
export const SEARCH_KINDS: readonly SearchKind[] = ["settings", "sessions", "tasks", "commits", "code", "knowledge"];
export const SEARCH_LABELS: Record<SearchKind, string> = { settings: "Settings", sessions: "Sessions", tasks: "Tasks", commits: "Commits", code: "Code", knowledge: "Knowledge" };
export type SearchHit = LocalSearchHit | NativeSearchHit | TaskSearchHit | CommitSearchHit | HybridCommitHit;
export interface SearchSources {
  repository?: (workspace: string, request: NativeSearchRequest, signal: AbortSignal) => Promise<NativeSearchResponse>;
  local?: (request: SearchQueryRequest, signal: AbortSignal) => Promise<SearchQueryResponse>;
  tasks?: (workspace: string) => Promise<ProjectTaskDocument>;
  taskAttachmentNames?: (workspace: string) => Promise<Readonly<Record<string, readonly string[]>>>;
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
  const patchOnly = patchSearchTerm(query) !== undefined;
  if (patchOnly) types = types.filter(kind => kind === "commits");
  if (!types.length) return result;
  const indexQuery = normalizeSearchConcepts(query);
  const localTypes = types.filter((kind): kind is "settings" | "sessions" => kind === "settings" || kind === "sessions");
  const groups = new Map<string, SearchHit[]>();
  const pending = new Map<string, string>();
  let latest = result;
  const emit = () => {
    if (signal.aborted) return;
    latest = {
      ...result,
      results: rankSearchHits([
        ...(groups.get("commits-hybrid") ?? []),
        ...[...groups].filter(([group]) => group !== "commits-hybrid").flatMap(([, hits]) => hits),
      ], query, settings, Boolean(result.status?.enabled && result.status.keyAvailable)),
      notices: [...result.notices, ...pending.values()],
      ...(pending.size ? { pendingSources: [...pending.keys()] } : {}),
    };
    onUpdate?.(latest);
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
    });
  await Promise.all([
    bounded("Tasks", async signal => {
      if (!types.includes("tasks") || !workspace) return;
      try {
        if (!sources.tasks) throw new Error("Task source unavailable");
        const metadata = sources.taskAttachmentNames?.(workspace).catch(() => ({}));
        const tasks = await sources.tasks(workspace);
        const attachmentNames = metadata ? await metadata : {};
        if (!signal.aborted) groups.set("tasks", searchProjectTasks(tasks, query, attachmentNames));
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
        if (response.pendingIndex) result.notices.push("Semantic Tasks: first-use indexing is incomplete; search again to index more tasks.");
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
        groups.set("local", [...response.results]);
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
          const response = await sources.repository(workspace, { query: indexQuery, sources: indexTypes, mode: "lexical", limit: 30, includeContent: true }, signal);
          if (signal.aborted) return;
          if (!response.status.generation && !response.status.complete) throw new Error("Native snapshot unavailable");
          for (const kind of indexTypes) groups.set(kind, response.hits.filter(hit => hit.kind === kind).slice(0, 15));
          result.notices.push(...response.notices);
          emit();
          if (response.status.semanticEnabled) {
            try {
              const enriched = await sources.repository(workspace, { query: indexQuery, sources: indexTypes,
                mode: "hybrid", limit: 30, includeContent: true }, signal);
              if (signal.aborted) return;
              if (enriched.status.generation || enriched.status.complete) {
                for (const kind of indexTypes) groups.set(kind, enriched.hits.filter(hit => hit.kind === kind).slice(0, 15));
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
          result.notices.push("Native Code/Knowledge search is unavailable. Configure this project's native search settings and retry.");
        }
      }
    }),
  ]);
  if (signal.aborted) return { ...result, results: [], notices: [] };
  emit();
  return latest;
}
