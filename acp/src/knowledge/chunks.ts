import { createHash } from "node:crypto";
import { compareKnowledge, type CheckCompletion, type CheckDocument, type ComparisonResult, type KnowledgeConflict } from "./comparison.js";
import { MAX_KNOWLEDGE_CHUNK_CHARS, MAX_KNOWLEDGE_CHUNKS, MAX_KNOWLEDGE_REVIEWED_CHARS, MAX_KNOWLEDGE_REVIEWED_PASSAGES,
  type KnowledgeCheckRequest, type KnowledgeCheckResult, type KnowledgeCitation, type KnowledgeCoverageLimit, type KnowledgeReportLanguage } from "./contract.js";
import type { KnowledgeSnapshot } from "./evidence.js";
import { reportMessage } from "./report-language.js";
import { boundChunkReport } from "./chunk-report.js";

export interface KnowledgeDocumentChunk extends CheckDocument { readonly startLine: number; }

/** Balanced, lossless slices keep the original line offsets and never split a CRLF or surrogate pair. */
export function splitKnowledgeDocument(document: CheckDocument): KnowledgeDocumentChunk[] {
  if (document.text.length <= MAX_KNOWLEDGE_CHUNK_CHARS) return [{ ...document, startLine: 1 }];
  const text = document.text;
  const intact = (offset: number) => !(text[offset - 1] === "\r" && text[offset] === "\n")
    && !(offset > 0 && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset] ?? ""));
  for (let count = Math.ceil(text.length / MAX_KNOWLEDGE_CHUNK_CHARS); count <= MAX_KNOWLEDGE_CHUNKS; count++) {
    const chunks: KnowledgeDocumentChunk[] = [];
    let start = 0, startLine = 1;
    for (let index = 0; index < count; index++) {
      const remaining = count - index - 1;
      const minimum = Math.max(start + 1, text.length - remaining * MAX_KNOWLEDGE_CHUNK_CHARS);
      const maximum = Math.min(start + MAX_KNOWLEDGE_CHUNK_CHARS, text.length);
      let end = remaining ? Math.min(maximum, start + Math.ceil((text.length - start) / (remaining + 1))) : text.length;
      if (remaining) {
        const boundary = (separator: string) => {
          const before = text.lastIndexOf(separator, end - separator.length);
          const after = text.indexOf(separator, Math.max(start, end - separator.length + 1));
          return [before, after].filter(at => at >= start).map(at => at + separator.length)
            .filter(at => at >= minimum && at <= maximum && Math.abs(at - end) <= 1200)
            .sort((left, right) => Math.abs(left - end) - Math.abs(right - end))[0] ?? -1;
        };
        const paragraph = Math.max(boundary("\n\n"), boundary("\r\n\r\n"));
        const line = boundary("\n");
        const space = boundary(" ");
        end = [paragraph, line, space].find(boundary => boundary >= minimum && boundary > start) ?? end;
        if (!intact(end)) end = end > minimum ? end - 1 : end < maximum ? end + 1 : -1;
      }
      if (end < minimum || end > maximum || !intact(end)) break;
      const chunk = text.slice(start, end);
      chunks.push({ path: document.path, text: chunk, startLine,
        ...(start ? { context: text.slice(0, 1200) + "\n" + text.slice(Math.max(0, start - 1200), start) } : {}) });
      startLine += (chunk.match(/\r\n?|\n/gu) ?? []).length;
      start = end;
    }
    if (start === text.length) return chunks;
  }
  throw new Error("The Wiki document cannot fit the bounded chunk plan.");
}

interface ChunkCheckOptions {
  readonly request: KnowledgeCheckRequest;
  readonly body: string;
  readonly chunks: readonly KnowledgeDocumentChunk[];
  readonly firstSnapshot: KnowledgeSnapshot;
  readonly collect: (request: KnowledgeCheckRequest) => Promise<KnowledgeSnapshot>;
  readonly complete: CheckCompletion;
  readonly signal: AbortSignal;
  readonly reportLanguage: KnowledgeReportLanguage;
  readonly modelRef: string;
  readonly warn?: (message: string) => void;
}

function pair(finding: KnowledgeConflict): string {
  return [JSON.stringify(finding.draft), JSON.stringify(finding.existing)].sort().join("\n");
}

function sourceCitation(source: KnowledgeSnapshot["evidence"][number]): KnowledgeCitation | undefined {
  const quote = source.text.replace(/\r\n?/gu, "\n");
  if (!quote.trim() || !Number.isSafeInteger(source.startLine) || source.startLine < 1) return undefined;
  return { path: source.path, quote, startLine: source.startLine,
    endLine: source.startLine + (quote.slice(0, -1).match(/\n/gu)?.length ?? 0) };
}

/** A single queue job owns every chunk, all cross-chunk pairs and one final freshness fence. */
export async function checkKnowledgeChunks(options: ChunkCheckOptions): Promise<KnowledgeCheckResult> {
  const { request, chunks, signal, reportLanguage: language } = options;
  const message = (key: Parameters<typeof reportMessage>[1]) => reportMessage(language, key);
  const snapshots: KnowledgeSnapshot[] = [], notices = new Set<string>(), limits = new Set<KnowledgeCoverageLimit>();
  const sources = new Map<string, KnowledgeCitation>(), sourcePaths = new Set<string>(), candidates = new Set<string>(), excerptedPaths = new Set<string>();
  const conflicts = new Map<string, KnowledgeConflict>(), uncertainties = new Map<string, KnowledgeConflict>();
  let allComplete = true, checkedChunks = 0, checkedComparisons = 0, excerptedSources = 0, candidateCount = 0;
  function merge(result: ComparisonResult): void {
    checkedComparisons++;
    allComplete &&= result.complete;
    for (const notice of result.notices) notices.add(notice);
    for (const finding of result.uncertainties) {
      const key = pair(finding);
      if (conflicts.delete(key)) notices.add(message("outcomeAmbiguous"));
      uncertainties.set(key, finding);
    }
    for (const finding of result.conflicts) {
      const key = pair(finding);
      if (uncertainties.has(key)) { notices.add(message("outcomeAmbiguous")); allComplete = false; }
      else if (!conflicts.has(key)) conflicts.set(key, finding);
    }
  }
  try {
    for (const [index, chunk] of chunks.entries()) {
      signal.throwIfAborted();
      const snapshot = index === 0 ? options.firstSnapshot : await options.collect({ ...request, content: chunk.text });
      signal.throwIfAborted();
      snapshots.push(snapshot);
      allComplete &&= snapshot.complete && snapshot.evidence.length > 0;
      if (!snapshot.evidence.length) notices.add(message("noWikiEvidence"));
      for (const notice of snapshot.notices) notices.add(notice);
      for (const limit of snapshot.coverage?.limits ?? []) limits.add(limit);
      for (const path of snapshot.candidatePaths ?? []) candidates.add(path);
      for (const path of snapshot.excerptedPaths ?? []) excerptedPaths.add(path);
      candidateCount = Math.max(candidateCount, snapshot.coverage?.candidateSources ?? 0);
      excerptedSources = Math.max(excerptedSources, snapshot.coverage?.excerptedSources ?? 0);
      for (const source of snapshot.evidence) {
        sourcePaths.add(source.path);
        const citation = sourceCitation(source);
        if (citation) sources.set(JSON.stringify(citation), citation);
        else { allComplete = false; notices.add(message("reviewedSourcesInvalid")); }
      }
      merge(await compareKnowledge(chunk, snapshot.evidence, options.complete, signal, language));
      checkedChunks++;
    }
    // Separate chunks can disagree even when each agrees with its retrieved Wiki passages.
    for (let left = 0; left < chunks.length; left++) for (let right = left + 1; right < chunks.length; right++) {
      signal.throwIfAborted();
      const other = chunks[right]!;
      merge(await compareKnowledge(chunks[left]!, [{ id: `draft-part-${right + 1}`, path: other.path,
        text: other.text, startLine: other.startLine, ...(other.context ? { context: other.context } : {}) }],
      options.complete, signal, language));
    }
  } catch (error) {
    signal.throwIfAborted();
    allComplete = false;
    notices.add(message("chunkComparisonFailed"));
    options.warn?.(`Wiki document-part comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  signal.throwIfAborted();
  const chunkCoverage = { totalChunks: chunks.length, checkedChunks,
    totalComparisons: chunks.length * (chunks.length + 1) / 2, checkedComparisons };
  const base = { path: request.path, documentHash: createHash("sha256").update(options.body).digest("hex"),
    modelRef: options.modelRef, reportLanguage: language, checkedSources: sourcePaths.size, chunkCoverage };
  // Recheck every original snapshot: a later successful retrieval cannot overwrite earlier stale evidence.
  for (const snapshot of snapshots) {
    const current = await snapshot.current(signal);
    signal.throwIfAborted();
    if (!current) {
      options.warn?.("Wiki contradiction check invalidated by changed source content");
      return boundChunkReport({ ...base, status: "incomplete", conflicts: [], uncertainties: [], reviewedSources: [],
        notices: [...notices, message("corpusChanged")] }, language);
    }
  }
  signal.throwIfAborted();
  if (conflicts.size > 20) { allComplete = false; notices.add(message("conflictLimit")); }
  if (uncertainties.size > 10) { allComplete = false; notices.add(message("uncertaintyLimit")); }
  const reviewedSources: KnowledgeCitation[] = [];
  let characters = 0;
  for (const source of sources.values()) {
    if (reviewedSources.length >= MAX_KNOWLEDGE_REVIEWED_PASSAGES || characters + source.quote.length > MAX_KNOWLEDGE_REVIEWED_CHARS) continue;
    reviewedSources.push(source); characters += source.quote.length;
  }
  const sampled = reviewedSources.length !== sources.size;
  if (sampled) notices.add(message("reviewedSourcesSampled"));
  const complete = allComplete && checkedComparisons === chunkCoverage.totalComparisons && checkedChunks === chunks.length;
  if (!complete) options.warn?.("Wiki chunked check returned incomplete evidence or model output");
  return boundChunkReport({ ...base, status: conflicts.size ? "conflicts" : complete ? "clear" : "incomplete",
    conflicts: [...conflicts.values()].slice(0, 20), uncertainties: [...uncertainties.values()].slice(0, 10),
    reviewedSources, notices: [...notices], coverage: { scope: "retrieved-passages", checkedPassages: sources.size,
      candidateSources: Math.max(candidateCount, candidates.size, sourcePaths.size),
      excerptedSources: Math.max(excerptedSources, excerptedPaths.size),
      limits: [...limits], ...(sampled ? { retainedPassages: reviewedSources.length } : {}) } }, language);
}
