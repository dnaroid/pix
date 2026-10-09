import type { RagRequest, RagSource } from "../../../acp/src/search/rag-contract";
import type { SearchHit, SearchKind, UnifiedSearchResult } from "./universal-search";

/** Diversity cap prevents a large run of commits/settings crowding out code and docs. */
export function selectRagHits(hits: readonly SearchHit[], limit = 12): SearchHit[] {
  const count = new Map<SearchKind, number>();
  const chosen: SearchHit[] = [];
  for (const hit of hits) {
    const seen = count.get(hit.kind) ?? 0;
    if (seen >= 4) continue;
    count.set(hit.kind, seen + 1);
    chosen.push(hit);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

export function ragSource(hit: SearchHit): RagSource {
  const source: RagSource = { id: hit.id, kind: hit.kind, title: hit.title, snippet: hit.snippet };
  if (hit.kind === "code" || hit.kind === "knowledge") {
    return { ...source, path: hit.path, startLine: hit.startLine, endLine: hit.endLine,
      ...(hit.content ? { content: hit.content.slice(0, 4096) } : {}) };
  }
  if (hit.kind === "commits") return { ...source, hash: hit.hash };
  if (hit.kind === "sessions") return { ...source, sessionId: hit.sessionId };
  return source;
}

export function ragRequest(cwd: string, query: string, hits: readonly SearchHit[], requestId: string): RagRequest {
  return { cwd, query, requestId, sources: hits.map(ragSource) };
}

/** Incrementally render verified numeric citations, keeping unknown references inert. */
export type RagAnswerPart = { readonly text: string } | { readonly citation: number };
export function ragAnswerParts(answer: string, sourceCount: number): RagAnswerPart[] {
  const result: RagAnswerPart[] = [];
  let start = 0;
  const regex = /\[(\d{1,2})\]/gu;
  for (const match of answer.matchAll(regex)) {
    const index = match.index;
    const citation = Number(match[1]);
    if (citation < 1 || citation > sourceCount) continue;
    if (index > start) result.push({ text: answer.slice(start, index) });
    result.push({ citation });
    start = index + match[0].length;
  }
  if (start < answer.length) result.push({ text: answer.slice(start) });
  return result;
}

/** Turn only verified numeric source references into internal Markdown anchors. */
export function linkRagCitations(answer: string, sourceCount: number): string {
  return answer.replace(/\[(\d{1,2})\]/gu, (raw, digits: string) => {
    const number = Number(digits);
    return number >= 1 && number <= sourceCount ? `[[${number}]](#pix-rag-source-${number})` : raw;
  });
}

/**
 * Retrieve from all existing project search providers; prefer a settled snapshot
 * but accept bounded partial evidence if an IDX source continues after its deadline.
 */
export async function retrieveRagHits(
  search: (onUpdate: (result: UnifiedSearchResult) => void) => Promise<UnifiedSearchResult>,
  signal: AbortSignal,
  update: (result: UnifiedSearchResult) => void,
): Promise<SearchHit[]> {
  signal.throwIfAborted();
  let latest: UnifiedSearchResult | undefined;
  const result = await search(next => {
    if (!signal.aborted) { latest = next; update(next); }
  });
  signal.throwIfAborted();
  // Use the latest completed snapshot without waiting indefinitely for a slow IDX.
  return selectRagHits((latest ?? result).results);
}
