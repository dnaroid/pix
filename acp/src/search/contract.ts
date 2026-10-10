/** Desktop-only search: authored settings metadata and local session titles. */
export const SEARCH_QUERY_METHOD = "pix/search/query";
export const SEARCH_CONFIG_METHOD = "pix/search/config";
export const SEARCH_COMMITS_METHOD = "pix/search/commits";
export const SEARCH_INTENT_METHOD = "pix/search/intent";
export const SEARCH_TASKS_METHOD = "pix/search/tasks";
export interface SearchIntentRequest {
  readonly cwd: string;
  readonly query: string;
}
export interface SearchIntentResponse {
  readonly intent: "search" | "ask";
  /** Missing credential, provider failure or invalid Jev decision defaults to Search. */
  readonly fallback: boolean;
}
export const SEARCH_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export interface CommitSearchRequest {
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
}
export interface CommitMetadata {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  /** Paths changed by this commit; metadata only, never patch contents. */
  readonly changedPaths?: readonly string[];
}
export interface CommitSearchHit {
  readonly kind: "commits";
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly hash: string;
  readonly commit: CommitMetadata;
  readonly semantic?: boolean;
  /** Full-message lexical evidence may not appear in the metadata snippet. */
  readonly contentMatch?: boolean;
}
export interface CommitSearchResponse {
  readonly results: readonly CommitSearchHit[];
  readonly notices: readonly string[];
}

export interface SearchSetting {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly synonyms: readonly string[];
}
export type LocalSearchKind = "settings" | "sessions";
export interface SearchQueryRequest {
  readonly cwd: string;
  readonly query: string;
  readonly types: readonly LocalSearchKind[];
  readonly settings: readonly SearchSetting[];
  readonly limit: number;
}
export interface SearchConfigRequest {
  readonly cwd: string;
  readonly enabled?: boolean;
  /** Independent opt-in to send explicit session names (not first-message fallbacks) to OpenRouter. */
  readonly sessionTitlesEnabled?: boolean;
  /** Independent opt-in before title/description of project tasks can be uploaded. */
  readonly tasksSemanticEnabled?: boolean;
  /** Write-only; goes to the existing shared OpenRouter credential store. */
  readonly apiKey?: string;
}
export interface SearchStatus {
  readonly enabled: boolean;
  readonly sessionTitlesEnabled?: boolean;
  readonly tasksSemanticEnabled?: boolean;
  readonly keyAvailable: boolean;
  readonly indexing: boolean;
  readonly error?: string;
  readonly warning?: string;
}
export interface SemanticTasksRequest {
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
}
export interface SemanticTaskHit {
  readonly kind: "tasks";
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly semantic: true;
}
export interface SemanticTasksResponse {
  readonly results: readonly SemanticTaskHit[];
  readonly pendingIndex: boolean;
}
interface SearchHitBase {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}
export interface SettingsSearchHit extends SearchHitBase {
  readonly kind: "settings";
  readonly section: string;
  readonly fieldId: string;
}
export interface SessionSearchHit extends SearchHitBase {
  readonly kind: "sessions";
  readonly sessionId: string;
  /** Local FTS evidence from the session's first user / last completed assistant message. */
  readonly boundaryMatch?: boolean;
  /** An explicit saved-title embedding matched without necessarily matching visible words. */
  readonly semantic?: boolean;
}
export type LocalSearchHit = SettingsSearchHit | SessionSearchHit;
export interface SearchQueryResponse {
  readonly results: readonly LocalSearchHit[];
  readonly status: SearchStatus;
}
