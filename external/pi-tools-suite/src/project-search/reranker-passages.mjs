import { queryIdentifiers, queryTerms, searchTokens } from "./native-ranking.mjs";

// Sentence/line selection is extractive: no translator/model call and no bytes
// outside the already authorized chunk. Work is bounded by the chunk limits.
const negative = /\b(?:not|never|cannot|without)\b|(?<!\p{L})(?:не|нельзя|никогда|без)(?!\p{L})/iu;
const encoder = new TextEncoder(), decoder = new TextDecoder();
/** Code needs contiguous syntax, not disconnected sentence fragments. */
export function contiguousPassage(query, text, bytes) {
  const lower = text.toLowerCase();
  const terms = [...queryIdentifiers(query), ...queryTerms(query)].map(term => term.toLowerCase());
  const matched = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? 0;
  let start = Math.max(0, matched - 48);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--;
  return bytePrefix(text.slice(start), bytes);
}
export function bytePrefix(text, bytes) {
  if (bytes <= 0) return "";
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = Math.floor(bytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

/** Keep strong literal anchors contiguous. Otherwise cover the whole question,
 * or representative sentences when query and chunk have no literal overlap. */
export function selectPassage(query, text, bytes) {
  if (encoder.encode(text).length <= bytes) return text;
  const tokens = new Set(searchTokens(text));
  const lower = text.toLowerCase();
  const anchors = query.match(/\b(?:[A-Z]{2,}|\d+)\b/g) ?? [];
  if (queryIdentifiers(query).some(term => lower.includes(term.toLowerCase()))
    || anchors.some(term => tokens.has(term.toLowerCase()))) {
    return contiguousPassage(query, text, bytes);
  }
  const parts = text.split(/(?<=[.!?])\s+|\n\s*\n|\n(?=[ \t]*(?:[-*#]|export\b|function\b|const\b))/u)
    .map((part, index) => ({ text: part.replace(/\s+/gu, " ").trim(), index }))
    .filter(part => /[\p{L}\p{N}]/u.test(part.text));
  const terms = new Set(queryTerms(query)), counts = new Map();
  for (const part of parts) {
    part.tokens = new Set(searchTokens(part.text));
    for (const token of part.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const part of parts) {
    const matched = [...part.tokens].filter(token => terms.has(token));
    const coverage = matched.reduce((sum, token) => sum + Math.log(1 + parts.length / counts.get(token)), 0);
    // Central vocabulary represents the chunk's subject; inverse frequency
    // alone instead favours long, incidental implementation/link paragraphs.
    const words = [...part.tokens].filter(token => token.length > 3);
    const information = words.length >= 5
      ? words.reduce((sum, token) => sum + Math.log(1 + counts.get(token)), 0) / words.length : 0;
    // Literal question coverage dominates the representative-vocabulary tie-break.
    part.score = coverage * 10 + information * (negative.test(query) && negative.test(part.text) ? 1.5 : 1);
  }
  const ranked = parts.sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked[0] && encoder.encode(ranked[0].text).length > bytes) {
    return contiguousPassage(query, ranked[0].text, bytes);
  }
  const selected = []; let used = 0;
  for (const part of ranked) {
    const cost = encoder.encode(part.text).length + (selected.length ? 5 : 0);
    if (cost + used <= bytes) { selected.push(part); used += cost; }
  }
  if (!selected.length) return bytePrefix(ranked[0]?.text ?? text, bytes);
  // Original order makes exclusions and antecedents easier to read. An ellipsis
  // explicitly marks omitted source text; it is not a fabricated sentence join.
  return selected.sort((a, b) => a.index - b.index).map(part => part.text).join(" … ");
}
