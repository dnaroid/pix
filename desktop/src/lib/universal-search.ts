import type { LocalSearchHit, SearchQueryRequest, SearchQueryResponse, SearchSetting, SearchStatus, SemanticTasksResponse } from "../../../acp/src/search/contract";
import type { IdxCommandResult, IdxOverview } from "./idx";
import { querySnapshot, snapshotLockBusy } from "./snapshot-search-queue";
import type { GitHistoryEntry } from "./git-workflow";
import type { ProjectTaskDocument } from "./project-tasks";
import { searchProjectTasks, searchRecentCommits, type TaskSearchHit, type CommitSearchHit } from "./project-search";
import { rankSearchHits } from "./search-relevance";
import { indexSearchQuery, patchSearchTerm } from "./search-query";
import { pendingSearchNotice, runSearchSource } from "./search-source-deadline";
import type { CommitSearchResponse, CommitSearchHit as HybridCommitHit } from "../../../acp/src/search/contract";

export type SearchIndexQuery =
  | { kind: "code"; query: string; mode: "hybrid"; maxFiles: number; includeContent?: boolean }
  | { kind: "knowledge"; query: string; limit: number; includeContent?: boolean };

export type SearchKind = "settings" | "sessions" | "tasks" | "commits" | "code" | "knowledge";
export const SEARCH_KINDS: readonly SearchKind[] = ["settings", "sessions", "tasks", "commits", "code", "knowledge"];
export const SEARCH_LABELS: Record<SearchKind, string> = { settings: "Settings", sessions: "Sessions", tasks: "Tasks", commits: "Commits", code: "Code", knowledge: "Knowledge" };
export interface IndexSearchHit {
  kind: "code" | "knowledge";
  id: string;
  title: string;
  snippet: string;
  /** Bounded content supplied by IDX; never read source files from the UI thread. */
  content?: string;
  score: number;
  path: string;
  startLine: number;
  endLine: number;
}
export type SearchHit = LocalSearchHit | IndexSearchHit | TaskSearchHit | CommitSearchHit | HybridCommitHit;
export interface SearchSources {
  local?: (request: SearchQueryRequest, signal: AbortSignal) => Promise<SearchQueryResponse>;
  overview?: (workspace: string) => Promise<IdxOverview>;
  index?: (workspace: string, query: SearchIndexQuery) => Promise<IdxCommandResult>;
  tasks?: (workspace: string) => Promise<ProjectTaskDocument>;
  taskAttachmentNames?: (workspace: string) => Promise<Readonly<Record<string, readonly string[]>>>;
  taskSemantic?: (workspace: string, query: string, signal: AbortSignal) => Promise<SemanticTasksResponse>;
  commits?: (workspace: string, query: string) => Promise<GitHistoryEntry[]>;
  commitHybrid?: (workspace: string, query: string, signal: AbortSignal) => Promise<CommitSearchResponse>;
}
export interface UnifiedSearchResult {
  results: SearchHit[];
  status?: SearchStatus;
  idxAvailable: boolean;
  notices: string[];
  pendingSources?: string[];
}

/** Parse IDX's length-delimited excerpts; never interpret header-like body text as a hit. */
export function parseIndexSearch(output: string, kind: "code" | "knowledge"): IndexSearchHit[] {
  const results: IndexSearchHit[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+?):(\d+)-(\d+) \(score: ([0-9.]+), rank=[^,]+, domain=(code|document)(?:,.*)?\)$/.exec(lines[i]!.trim());
    if (!match) continue;
    let content = "";
    let marker = i + 1;
    if (/^\s+kind=/u.test(lines[marker] ?? "")) marker++;
    const count = /^Content: (\d+) lines$/u.exec(lines[marker] ?? "");
    if (count) {
      const length = Number(count[1]);
      if (!Number.isSafeInteger(length) || marker + length >= lines.length) {
        // Truncated content must not be allowed to masquerade as more results.
        i = lines.length;
      } else {
        if (length) content = lines.slice(marker + 1, marker + 1 + length).join("\n").slice(0, 4096).trim();
        i = marker + length;
      }
    }
    if (match[5] !== (kind === "code" ? "code" : "document")) continue;
    const path = match[1]!;
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    const score = Number(match[4]);
    if (path.startsWith("/") || path.startsWith("~") || path.includes("\\") || path.split("/").some(part => !part || part === ".." || part === ".")
      || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || !Number.isFinite(score)) continue;
    const id = `${kind}:${path}:${startLine}-${endLine}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const preview = content.replace(/\s+/gu, " ").slice(0, 240);
    results.push({ kind, id, path, startLine, endLine, score, title: path,
      snippet: `Lines ${startLine}–${endLine}${preview ? `\n${preview}${content.length > 240 ? "…" : ""}` : ""}`,
      ...(content ? { content } : {}),
    });
  }
  return results;
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
  const result: UnifiedSearchResult = { results: [], idxAvailable: false, notices: [] };
  if (!query.trim() || !types.length || signal.aborted) return result;
  const patchOnly = patchSearchTerm(query) !== undefined;
  if (patchOnly) types = types.filter(kind => kind === "commits");
  if (!types.length) return result;
  const indexQuery = indexSearchQuery(query);
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
    bounded("Code / Knowledge (IDX)", async signal => {
      const indexTypes = types.filter((kind): kind is "code" | "knowledge" => kind === "code" || kind === "knowledge");
      if (!indexTypes.length || !workspace) return;
      const overviewSource = sources.overview;
      const indexSource = sources.index;
      if (!overviewSource || !indexSource) {
        result.notices.push("IDX search source is unavailable.");
        return;
      }
      try {
        const overview = await overviewSource(workspace);
        if (signal.aborted) return;
        result.idxAvailable = overview.available && overview.initialized;
        if (!result.idxAvailable) {
          result.notices.push("IDX is not available in this project. Settings and session titles remain searchable.");
          for (const error of overview.errors) result.notices.push(`IDX: ${searchErrorDetail(error)}`);
          return;
        }
        for (const kind of indexTypes) {
          if (signal.aborted) break;
          try {
            const response = await querySnapshot(workspace, kind === "code"
              ? { kind, query: indexQuery, mode: "hybrid", maxFiles: 15, includeContent: true }
              : { kind, query: indexQuery, limit: 15, includeContent: true }, signal, indexSource);
            if (signal.aborted) return;
            if (response.exitCode !== 0) {
              const exit = response.exitCode === undefined ? "without an exit code" : `with exit code ${response.exitCode}`;
              const detail = response.stderr.trim() || response.stdout.trim();
              throw new Error(`IDX failed ${exit}${detail ? `: ${detail}` : "."}`);
            }
            groups.set(kind, parseIndexSearch(response.stdout, kind));
            emit();
            for (const warning of response.stdout.split("\n").filter(line => line.startsWith("WARN ") && !/^WARN no-results\b/u.test(line)).slice(0, 5)) {
              result.notices.push(`${SEARCH_LABELS[kind]}: ${searchErrorDetail(warning)}`);
            }
            if (response.truncated) result.notices.push(`${SEARCH_LABELS[kind]} results were truncated.`);
          } catch (error) {
            if (!signal.aborted) result.notices.push(snapshotLockBusy(error)
              ? `${SEARCH_LABELS[kind]} search is temporarily unavailable: IDX is busy. Try Search again shortly.`
              : `${SEARCH_LABELS[kind]} search failed: ${searchErrorDetail(error)}`);
          }
        }
      } catch (error) {
        if (!signal.aborted) result.notices.push(`Could not check this project's IDX index: ${searchErrorDetail(error)}`);
      }
    }),
  ]);
  if (signal.aborted) return { ...result, results: [], notices: [] };
  emit();
  return latest;
}
