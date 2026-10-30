import type { KnowledgeConflict, KnowledgeCitation, KnowledgeUncertainty } from "./comparison.js";
export type { KnowledgeConflict, KnowledgeCitation, KnowledgeUncertainty } from "./comparison.js";

export const KNOWLEDGE_CHECK_METHOD = "pix/knowledge/check";
export const MAX_KNOWLEDGE_DOCUMENT_CHARS = 128_000;
export const MAX_KNOWLEDGE_CHUNK_CHARS = 48_000;
export const MAX_KNOWLEDGE_CHUNKS = Math.ceil(MAX_KNOWLEDGE_DOCUMENT_CHARS / MAX_KNOWLEDGE_CHUNK_CHARS);
export const MAX_KNOWLEDGE_REVIEWED_PASSAGES = 12;
export const MAX_KNOWLEDGE_REVIEWED_CHARS = 48_000;
export type KnowledgeReportLanguage = "en" | "ru";

export interface KnowledgeCheckRequest {
  readonly cwd: string;
  readonly path: string;
  readonly content: string;
  readonly expectedContent?: string;
}

export const KNOWLEDGE_COVERAGE_LIMITS = ["query-sampling", "candidate-limit", "source-limit", "passage-limit", "context-limit"] as const;
export type KnowledgeCoverageLimit = typeof KNOWLEDGE_COVERAGE_LIMITS[number];

/** Describes selected material; it does not estimate how much of the Wiki is contradiction-free. */
export interface KnowledgeCheckCoverage {
  readonly scope: "retrieved-passages";
  readonly checkedPassages: number;
  readonly candidateSources: number;
  readonly excerptedSources: number;
  readonly limits: readonly KnowledgeCoverageLimit[];
  /** Present when the saved source list samples the passages actually compared. */
  readonly retainedPassages?: number;
}

export interface KnowledgeChunkCoverage {
  readonly totalChunks: number;
  readonly checkedChunks: number;
  readonly totalComparisons: number;
  readonly checkedComparisons: number;
}

export interface KnowledgeCheckResult {
  readonly status: "clear" | "conflicts" | "incomplete";
  readonly path: string;
  readonly documentHash: string;
  readonly modelRef: string;
  /** Effective trusted preference for this check; omitted by older backends. */
  readonly reportLanguage?: KnowledgeReportLanguage;
  readonly checkedSources: number;
  readonly coverage?: KnowledgeCheckCoverage;
  /** Large documents include independent Wiki checks and every cross-chunk pair. */
  readonly chunkCoverage?: KnowledgeChunkCoverage;
  readonly conflicts: readonly KnowledgeConflict[];
  /** Grounded competing claims whose deciding condition is missing; older results omit this field. */
  readonly uncertainties?: readonly KnowledgeUncertainty[];
  /** The exact supplied original passages, excluding background-only context. */
  readonly reviewedSources?: readonly KnowledgeCitation[];
  readonly notices: readonly string[];
}

/** A transport response must never turn malformed data into a successful check. */
export function isKnowledgeCheckResult(value: unknown): value is KnowledgeCheckResult {
  if (!record(value) || !["clear", "conflicts", "incomplete"].includes(String(value.status))
    || typeof value.path !== "string" || typeof value.documentHash !== "string"
    || typeof value.modelRef !== "string" || !Number.isSafeInteger(value.checkedSources)
    || (value.checkedSources as number) < 0 || !Array.isArray(value.notices)
    || value.notices.some(item => typeof item !== "string") || !Array.isArray(value.conflicts)
    || value.conflicts.length > 20) return false;
  if (value.coverage !== undefined && !coverage(value.coverage)) return false;
  if (value.chunkCoverage !== undefined && (!chunkCoverage(value.chunkCoverage)
    || (value.status === "clear" && (value.chunkCoverage.checkedChunks !== value.chunkCoverage.totalChunks
      || value.chunkCoverage.checkedComparisons !== value.chunkCoverage.totalComparisons)))) return false;
  if (value.reportLanguage !== undefined && value.reportLanguage !== "en" && value.reportLanguage !== "ru") return false;
  if (value.uncertainties !== undefined && (!Array.isArray(value.uncertainties)
    || value.uncertainties.length > 10 || !value.uncertainties.every(item => finding(item, 1_000)))) return false;
  if (value.reviewedSources !== undefined && (!Array.isArray(value.reviewedSources)
    || value.reviewedSources.length > MAX_KNOWLEDGE_REVIEWED_PASSAGES
    || !value.reviewedSources.every(item => citation(item, MAX_KNOWLEDGE_REVIEWED_CHARS))
    || value.reviewedSources.reduce((total: number, item: KnowledgeCitation) => total + item.quote.length, 0) > MAX_KNOWLEDGE_REVIEWED_CHARS)) return false;
  if (record(value.coverage) && value.coverage.retainedPassages !== undefined
    && (!Array.isArray(value.reviewedSources) || value.reviewedSources.length !== value.coverage.retainedPassages)) return false;
  if (value.status === "clear" && (value.conflicts.length !== 0
    || (Array.isArray(value.uncertainties) && value.uncertainties.length !== 0))) return false;
  if (value.status === "conflicts" && value.conflicts.length === 0) return false;
  return value.conflicts.every(conflict => finding(conflict, 2_000));
}

function coverage(value: unknown): boolean {
  return record(value) && value.scope === "retrieved-passages"
    && [value.checkedPassages, value.candidateSources, value.excerptedSources]
      .every(count => Number.isSafeInteger(count) && (count as number) >= 0)
    && Array.isArray(value.limits) && value.limits.length <= KNOWLEDGE_COVERAGE_LIMITS.length
    && new Set(value.limits).size === value.limits.length
    && (value.retainedPassages === undefined || (Number.isSafeInteger(value.retainedPassages)
      && (value.retainedPassages as number) >= 0 && (value.retainedPassages as number) <= (value.checkedPassages as number)))
    && value.limits.every(limit => KNOWLEDGE_COVERAGE_LIMITS.includes(limit));
}

function chunkCoverage(value: unknown): value is KnowledgeChunkCoverage {
  return record(value) && [value.totalChunks, value.checkedChunks, value.totalComparisons, value.checkedComparisons]
    .every(count => Number.isSafeInteger(count) && (count as number) >= 0)
    && (value.totalChunks as number) >= 1 && (value.totalChunks as number) <= MAX_KNOWLEDGE_CHUNKS
    && (value.checkedChunks as number) <= (value.totalChunks as number)
    && value.totalComparisons === (value.totalChunks as number) * ((value.totalChunks as number) + 1) / 2
    && (value.checkedComparisons as number) <= (value.totalComparisons as number)
    && (value.checkedComparisons as number) >= (value.checkedChunks as number);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function citation(value: unknown, quoteLimit = 4_000): value is KnowledgeCitation {
  return record(value) && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096
    && typeof value.quote === "string" && value.quote.trim().length > 0 && value.quote.length <= quoteLimit
    && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine)
    && (value.startLine as number) > 0 && (value.endLine as number) >= (value.startLine as number);
}

function finding(value: unknown, explanationLimit: number): boolean {
  return record(value) && typeof value.explanation === "string"
    && value.explanation.trim().length > 0 && value.explanation.length <= explanationLimit
    && citation(value.draft) && citation(value.existing);
}
