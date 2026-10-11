import { SEARCH_CACHE_REBUILD_REQUIRED } from "../../../acp/src/search/contract";

/** Pure mapping from read-only search-store diagnostics to per-source rows. Unknown is never shown as ready. */
export type SearchStoreId = SearchSourceId;
export interface SearchStoreStatus {
  readonly id: SearchStoreId;
  readonly state: "absent" | "present" | "error";
  readonly sizeBytes?: number | null;
  readonly modifiedAtMs?: number | null;
  readonly generation?: number | null;
  readonly completedAt?: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly incompatibleSources?: readonly SearchSourceId[];
  readonly error?: string | null;
}
export interface SearchIndexStatus { readonly stores: readonly SearchStoreStatus[]; readonly commitsEmpty?: boolean | null }
export interface SemanticConsent { readonly configured: boolean; readonly provider: string | null; readonly model: string | null; readonly vectorSize: number | null; readonly keyAvailable: boolean }

export type SearchSourceId = "code" | "knowledge" | "settings" | "sessions" | "tasks" | "commits";
export interface SearchIndexActivity {
  readonly sessionsEmpty?: boolean;
  readonly indexingSources?: { readonly settings: boolean; readonly tasks: boolean; readonly sessions: boolean };
  readonly sourceErrors?: { readonly settings?: string; readonly tasks?: string; readonly sessions?: string };
}
/** ready | building (started, not complete) | missing (no index) | error | unknown (not reported). */
export type SearchLocalState = "ready" | "incomplete" | "missing" | "on-demand" | "error" | "unknown";
export type SearchSemanticState = "disabled" | "unavailable" | "no-vectors" | "vectors" | "incompatible" | "error" | "unknown";

export interface SearchSourceRow {
  readonly empty?: boolean;
  readonly id: SearchSourceId;
  readonly label: string;
  readonly local: SearchLocalState;
  readonly localDetail: string;
  readonly localSummary?: string;
  readonly semantic: SearchSemanticState;
  readonly semanticDetail: string;
  readonly semanticActive?: boolean;
}

const LABELS: Record<SearchSourceId, string> = { code: "Code", knowledge: "Knowledge", settings: "Settings", sessions: "Sessions", tasks: "Tasks", commits: "Git commits" };

function n(value: number | undefined): string { return (value ?? 0).toLocaleString("en-US"); }

function semanticFor(
  vectorStore: SearchStoreStatus | undefined,
  consent: SemanticConsent | null | undefined,
  vectorCount: number | undefined,
  consentKnown: boolean,
): { state: SearchSemanticState; detail: string } {
  if (vectorStore?.state === "error") return { state: "error", detail: vectorStore.error ?? "Vector store unreadable" };
  if (consentKnown) {
    if (!consent) return { state: "unknown", detail: "Semantic settings could not be read" };
    if (!consent.configured) {
      return { state: "disabled", detail: vectorCount ? `Disabled; ${n(vectorCount)} stored vectors are retained but unused` : "Disabled; no data is sent to a provider" };
    }
    if (consent.provider === "openrouter" && !consent.keyAvailable) return { state: "unavailable", detail: `Configured for ${consent.provider} · ${consent.model ?? "unknown model"}, but no OpenRouter key was found` };
  }
  if (!consentKnown) {
    return { state: "unknown", detail: vectorCount ? `${n(vectorCount)} stored vectors; semantic configuration is unreadable` : "Semantic configuration is unreadable" };
  }
  if (!vectorCount) return { state: "no-vectors", detail: `Configured: ${consent?.provider} · ${consent?.model}. No vectors reported yet` };
  return { state: "vectors", detail: `${n(vectorCount)} stored vectors; configured ${consent?.provider} · ${consent?.model} (coverage per source is not reported)` };
}

export function buildSearchSourceRows(
  status: SearchIndexStatus | null | undefined,
  consent: SemanticConsent | null | undefined,
  activity?: SearchIndexActivity | null,
  settingsCount?: number,
): SearchSourceRow[] {
  const store = (id: SearchStoreId) => status?.stores.find(item => item.id === id);
  const rows: SearchSourceRow[] = [];

  for (const id of ["code", "knowledge"] as const) {
    const files = store(id);
    const vectors = files;
    let local: SearchLocalState;
    let localDetail: string;
    const chunks = files?.counts[id === "code" ? "codeChunks" : "knowledgeChunks"];
    if (!status || !files) { local = "unknown"; localDetail = "Status not read"; }
    else if (files.state === "error") { local = "error"; localDetail = files.error ?? "Index unreadable"; }
    else if (files.state === "absent") { local = "missing"; localDetail = "Not built yet; the next search builds it locally without network use"; }
    else if (!files.completedAt) { local = "incomplete"; localDetail = "A scan has not completed; prior results may be partial"; }
    else { local = "ready"; localDetail = `${n(chunks)} chunks · scan generation ${files.generation ?? "?"} · completed ${files.completedAt}. Edits since then are picked up by the next search`; }
    const sem = semanticFor(vectors, consent, vectors?.counts.vectors, true);
    rows.push({ id, label: LABELS[id], local, localDetail, localSummary: local === "ready" ? `${n(chunks)} chunks` : undefined, semantic: sem.state, semanticDetail: sem.detail });
  }

  for (const [id, docKey, vecKey] of [["settings", "settingsDocuments", "settingsVectors"], ["sessions", "sessionTitles", "sessionVectors"], ["tasks", "taskDocuments", "taskVectors"], ["commits", "commitDocuments", "commitVectors"]] as const) {
    const history = store(id);
    let local: SearchLocalState;
    let localDetail: string;
    const docs = history?.counts[docKey];
    const empty = id === "sessions" ? activity?.sessionsEmpty === true : id === "commits" && status?.commitsEmpty === true;
    if (empty) { local = "ready"; localDetail = "No source documents available to index"; }
    else if (id === "settings" && settingsCount !== undefined) { local = "ready"; localDetail = `${n(settingsCount)} authored fields, available locally; semantic metadata updates on catalogue changes`; }
    else if (!status || !history) { local = "unknown"; localDetail = "Status not read"; }
    else if (history.state === "error") { local = "error"; localDetail = history.error ?? "Index unreadable"; }
    else if (docs === undefined) { local = "on-demand"; localDetail = "No local semantic index for this source; lexical search reads the source directly"; }
    else { local = "ready"; localDetail = `${n(docs)} indexed documents (${id === "tasks" || id === "settings" ? "updated on changes" : "indexed on demand"}; freshness is not tracked)`; }
    const sem = semanticFor(history, consent, history?.counts[vecKey], true);
    const semanticActive = id !== "commits" && activity?.indexingSources?.[id] === true;
    const sourceError = id !== "commits" ? activity?.sourceErrors?.[id] : undefined;
    const incompatible = consent?.configured && (history?.incompatibleSources?.includes(id) || sourceError === SEARCH_CACHE_REBUILD_REQUIRED);
    rows.push({ id, label: LABELS[id], local, localDetail, empty,
      localSummary: local === "ready" ? `${n(empty ? 0 : id === "settings" ? settingsCount ?? docs : docs)} items` : undefined,
      semantic: incompatible ? "incompatible" : sourceError ? "error" : sem.state,
      semanticDetail: semanticActive ? "Indexing this source" : incompatible ? SEARCH_CACHE_REBUILD_REQUIRED : sourceError ?? sem.detail, semanticActive });
  }
  return rows;
}

export const SEARCH_LOCAL_LABEL: Record<SearchLocalState, string> = { ready: "Ready", incomplete: "Partial", missing: "On demand", "on-demand": "Direct", error: "Unavailable", unknown: "Unavailable" };
export const SEARCH_SEMANTIC_LABEL: Record<SearchSemanticState, string> = { disabled: "Off", unavailable: "Needs setup", "no-vectors": "Not indexed", vectors: "Stored", incompatible: "Needs rebuild", error: "Unavailable", unknown: "Unavailable" };
