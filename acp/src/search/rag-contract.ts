export const SEARCH_RAG_METHOD = "pix/search/rag";
export const SEARCH_RAG_DELTA_METHOD = "pix/search/rag_delta";

export type RagSourceKind = "settings" | "sessions" | "tasks" | "commits" | "code" | "knowledge";
export interface RagSource {
  readonly id: string;
  readonly kind: RagSourceKind;
  readonly title: string;
  readonly snippet: string;
  readonly content?: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly hash?: string;
  readonly sessionId?: string;
}
export interface RagRequest {
  readonly requestId: string;
  readonly cwd: string;
  readonly query: string;
  readonly sources: readonly RagSource[];
}
export interface RagDelta {
  readonly requestId: string;
  readonly text: string;
}
export interface RagProgress {
  readonly sourceIds?: readonly string[];
  readonly text?: string;
}
export interface RagResponse {
  readonly answer: string;
  readonly modelRef: string;
  /** Source IDs corresponding to numbered evidence [1], [2], ... in request order. */
  readonly sourceIds: readonly string[];
}

