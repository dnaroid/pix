import { queryIdentifiers, queryTerms } from "./native-ranking.mjs";

// Bound the entire batch, not only each passage. Large batches can exceed a
// provider's token/rate limit even though all 100 individual passages are valid.
export const MAX_RERANK_INPUT_BYTES = 32_000;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
function prefix(text, bytes) {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

/** Query-focused excerpts retain identifiers that occur below a chunk's start.
 * The input has already been source-authorized and bounded by the caller. */
export function rerankerDocuments(query, candidates) {
  const budget = Math.min(8192, Math.floor((MAX_RERANK_INPUT_BYTES - encoder.encode(query).length) / candidates.length));
  const terms = [...queryIdentifiers(query), ...queryTerms(query)].map(term => term.toLowerCase());
  return candidates.map(hit => {
    const header = prefix([hit.path, hit.title !== hit.path ? hit.title : ""].filter(Boolean).join("\n"), Math.min(160, Math.floor(budget / 2)));
    const text = hit.content ?? hit.snippet ?? "", lower = text.toLowerCase();
    const matched = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? 0;
    const start = Math.max(0, matched - 48);
    return prefix(`${header}\n${text.slice(start)}`, budget);
  });
}
