export const MAX_RERANK_INPUT_BYTES: number;
export function rerankerDocuments(query: string, candidates: {kind?: string; path?: string; title: string; content?: string; snippet?: string}[], lifecycles?: Map<string, string>): string[];
