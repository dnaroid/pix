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
  notices: string[];
  status: {
    backend: "native";
    complete: boolean;
    stale: boolean;
    mode?: "lexical" | "hybrid" | "semantic";
    semanticEnabled?: boolean;
    semantic?: { enabled: boolean; complete: boolean; state: "disabled" | "ready" | "partial" | "unavailable"; indexed?: number; total?: number };
    generation?: number;
    completedAt?: string;
    scannedFiles?: number;
    updatedFiles?: number;
  };
}
