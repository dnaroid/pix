import { bytePrefix, contiguousPassage, selectPassage } from "./reranker-passages.mjs";

// Bound the entire batch, not only each passage. Large batches can exceed a
// provider's token/rate limit even though all 100 individual passages are valid.
export const MAX_RERANK_INPUT_BYTES = 32_000;
const encoder = new TextEncoder();

/** Query-focused excerpts retain identifiers that occur below a chunk's start.
 * The input has already been source-authorized and bounded by the caller. */
export function rerankerDocuments(query, candidates, lifecycles = new Map()) {
  if (!candidates.length) return [];
  const budget = Math.min(8192, Math.floor((MAX_RERANK_INPUT_BYTES - encoder.encode(query).length) / candidates.length));
  if (budget <= 0) return candidates.map(() => "");
  return candidates.map(hit => {
    const status = hit.kind === "knowledge" ? lifecycles.get(hit.path) : undefined;
    const header = bytePrefix([status ? `Document status: ${status}` : "", hit.path, hit.title !== hit.path ? hit.title : ""].filter(Boolean).join("\n"), Math.min(160, Math.floor(budget / 2)));
    const select = hit.kind === "code" ? contiguousPassage : selectPassage;
    return `${header}\n${select(query, hit.content ?? hit.snippet ?? "", Math.max(0, budget - encoder.encode(header).length - 1))}`;
  });
}
