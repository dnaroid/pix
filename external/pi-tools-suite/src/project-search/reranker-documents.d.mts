export const MAX_RERANK_INPUT_BYTES: number;
export function rerankerDocuments(query: string, candidates: {path?: string; title: string; content?: string; snippet?: string}[]): string[];
