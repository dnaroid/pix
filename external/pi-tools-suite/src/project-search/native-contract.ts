export interface NativeIndexRequest {
  operation: "index";
  source: "code" | "knowledge";
}
export interface NativeIndexResponse {
  source: "code" | "knowledge";
  complete: boolean;
  indexed?: number;
  total?: number;
  message?: string;
}
export interface NativeSearchRequest {
  query: string;
  sources: ("code" | "knowledge")[];
  mode?: "lexical" | "hybrid" | "semantic";
  limit?: number;
  pathPrefix?: string;
  includeContent?: boolean;
  dedupeFile?: boolean;
  excludeTests?: boolean;
  includeTests?: boolean;
  /** Federation owns the single reranking pass; return freshness context instead. */
  skipRerank?: boolean;
}
export interface NativeSearchHit {
  kind: "code" | "knowledge";
  id: string;
  title: string;
  snippet: string;
  score: number;
  path: string;
  startLine: number;
  endLine: number;
  content?: string;
}
export interface NativeSearchResponse {
  hits: NativeSearchHit[];
  rerankContext?: NativeRerankContext;
  notices: string[];
  status: {
    backend: "native";
    complete: boolean;
    stale: boolean;
    mode?: "lexical" | "hybrid" | "semantic";
    semanticEnabled?: boolean;
    rerankerEnabled?: boolean;
    semantic?: { enabled: boolean; complete: boolean; state: "disabled" | "ready" | "partial" | "unavailable"; indexed?: number; total?: number };
    generation?: number;
    completedAt?: string;
    scannedFiles?: number;
    updatedFiles?: number;
  };
}

export type FederatedSource = "sessions" | "tasks" | "commits" | "code" | "knowledge";
export type NativeRerankContext = Partial<Record<"code" | "knowledge", { generation: number; hashes: Record<string, string> }>>;
export interface FederatedRerankContext {
  signature: string;
  policyRevision: string;
  sources: FederatedSource[];
  history: Partial<Record<FederatedSource, string>>;
}
export interface FederatedRerankCandidate {
  kind: FederatedSource;
  id: string;
  title: string;
  snippet: string;
  path?: string;
  content?: string;
}
export interface FederatedRerankRequest {
  query: string;
  context: FederatedRerankContext;
  candidates: FederatedRerankCandidate[];
  nativeContext?: NativeRerankContext;
}
export interface FederatedRerankResponse {
  order?: { kind: FederatedSource; id: string; score: number }[];
  notices: string[];
}
