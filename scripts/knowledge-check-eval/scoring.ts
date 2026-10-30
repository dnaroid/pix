import type { CheckDocument, CheckEvidence, ComparisonResult, KnowledgeConflict } from "../../acp/src/knowledge/comparison.js";
import type { KnowledgeCheckResult } from "../../acp/src/knowledge/contract.js";
import { reportMessage } from "../../acp/src/knowledge/report-language.js";
import type { KnowledgeEvalCase, KnowledgeEvalClass, KnowledgeEvalExpectedPair } from "./cases.js";

export interface KnowledgeEvalUnexpectedPair {
  readonly outcome: "conflict" | "uncertain";
  readonly index: number;
  readonly reason: "wrong-pair" | "duplicate";
  readonly finding: KnowledgeConflict;
}

export interface KnowledgeEvalScore {
  readonly passed: boolean;
  readonly classActual: KnowledgeEvalClass | "incomplete";
  readonly missingPairs: readonly KnowledgeEvalExpectedPair[];
  readonly unexpectedPairs: readonly KnowledgeEvalUnexpectedPair[];
  readonly technicalIncomplete: boolean;
  readonly conflicts: number;
  readonly uncertainties: number;
  readonly notices: readonly string[];
}

const normalize = (value: string) => value.replace(/\r\n?/gu, "\n");
const displayNotices = new Set(["en", "ru"].flatMap(language => [
  reportMessage(language as "en" | "ru", "reviewedSourcesSampled"),
]));

function matches(finding: KnowledgeConflict, expected: KnowledgeEvalExpectedPair, path: string): boolean {
  const contains = (quote: string, anchor: string) => normalize(quote).includes(normalize(anchor));
  if (finding.draft.path !== path || finding.existing.path !== expected.sourcePath) return false;
  if (contains(finding.draft.quote, expected.draftAnchor) && contains(finding.existing.quote, expected.existingAnchor)) return true;
  return expected.sourcePath === path && contains(finding.draft.quote, expected.existingAnchor)
    && contains(finding.existing.quote, expected.draftAnchor);
}

/** Evaluate the validated production result; discarded raw findings never become a clean success. */
export function scoreKnowledgeEval(fixture: KnowledgeEvalCase, result: ComparisonResult | KnowledgeCheckResult): KnowledgeEvalScore {
  const conflicts = result.conflicts, uncertainties = result.uncertainties ?? [];
  const retained = [...conflicts.map(finding => ({ outcome: "conflict" as const, finding })),
    ...uncertainties.map(finding => ({ outcome: "uncertain" as const, finding }))];
  const used = new Set<number>(), unexpectedPairs: KnowledgeEvalUnexpectedPair[] = [];
  retained.forEach(({ outcome, finding }, index) => {
    const candidates = fixture.expectedPairs.flatMap((expected, pairIndex) =>
      expected.outcome === outcome && matches(finding, expected, fixture.document.path) ? [pairIndex] : []);
    const match = candidates.find(pairIndex => !used.has(pairIndex));
    if (match !== undefined) used.add(match);
    else unexpectedPairs.push({ outcome, index, finding, reason: candidates.length ? "duplicate" : "wrong-pair" });
  });
  const missingPairs = fixture.expectedPairs.filter((_pair, index) => !used.has(index));
  const technicalNotices = result.notices.filter(notice => !displayNotices.has(notice));
  const unfinishedChunks = "chunkCoverage" in result && result.chunkCoverage !== undefined
    && (result.chunkCoverage.checkedChunks !== result.chunkCoverage.totalChunks
      || result.chunkCoverage.checkedComparisons !== result.chunkCoverage.totalComparisons);
  const incomplete = "status" in result ? result.status === "incomplete" : !result.complete;
  const technicalIncomplete = technicalNotices.length > 0 || Boolean(unfinishedChunks) || (incomplete && !uncertainties.length);
  const classActual = conflicts.length ? "conflict" : uncertainties.length ? "uncertain"
    : !technicalIncomplete && !incomplete ? "clear" : "incomplete";
  return { passed: classActual === fixture.expected && !technicalIncomplete && !missingPairs.length && !unexpectedPairs.length,
    classActual, missingPairs, unexpectedPairs, technicalIncomplete, conflicts: conflicts.length,
    uncertainties: uncertainties.length, notices: result.notices };
}

export interface KnowledgeEvalQuoteDiagnostic {
  readonly path: string | null;
  readonly quote: string | null;
  /** Null means the source/quotation was invalid; otherwise counts exact normalized occurrences. */
  readonly matches: number | null;
}

export interface KnowledgeEvalFindingDiagnostic {
  readonly kind: "conflict" | "uncertain";
  readonly index: number;
  readonly sourceId: string | null;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly draft: KnowledgeEvalQuoteDiagnostic;
  readonly existing: KnowledgeEvalQuoteDiagnostic;
}

export interface KnowledgeEvalResponseDiagnostic {
  readonly jsonValid: boolean;
  readonly schemaValid: boolean;
  readonly error?: string;
  readonly proposedConflicts: number;
  readonly proposedUncertainties: number;
  readonly findings: readonly KnowledgeEvalFindingDiagnostic[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(text: string, quote: string): number {
  const source = normalize(text), needle = normalize(quote);
  if (!needle) return 0;
  let matches = 0;
  for (let offset = source.indexOf(needle); offset >= 0; offset = source.indexOf(needle, offset + 1)) matches++;
  return matches;
}

function quotation(source: CheckDocument | undefined, value: unknown): KnowledgeEvalQuoteDiagnostic {
  const quote = typeof value === "string" ? value : null;
  return { path: source?.path ?? null, quote,
    matches: source && quote !== null && quote.trim().length > 0 && quote.length <= 4000 ? count(source.text, quote) : null };
}

/** Eval artifacts retain rejected model quotations; production reports and prompts are unchanged. */
export function diagnoseKnowledgeResponse(raw: string, document: CheckDocument, evidence: readonly CheckEvidence[]): KnowledgeEvalResponseDiagnostic {
  const empty = { proposedConflicts: 0, proposedUncertainties: 0, findings: [] };
  if (!raw.trim() || raw.length > 64_000) return { ...empty, jsonValid: false, schemaValid: false, error: "empty-or-oversized-response" };
  const trimmed = raw.trim(), fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : trimmed); }
  catch { return { ...empty, jsonValid: false, schemaValid: false, error: "invalid-json" }; }
  if (!record(value) || !Array.isArray(value.conflicts) || !Array.isArray(value.uncertainties)) {
    return { ...empty, jsonValid: true, schemaValid: false, error: "invalid-result-schema" };
  }
  let schemaValid = Object.keys(value).every(key => key === "conflicts" || key === "uncertainties")
    && value.conflicts.length <= 20 && value.uncertainties.length <= 10;
  const sources = new Map(evidence.map(source => [source.id, source]));
  const findings: KnowledgeEvalFindingDiagnostic[] = [];
  for (const [kind, entries, limit] of [["conflict", value.conflicts, 20], ["uncertain", value.uncertainties, 10]] as const) {
    for (const [index, candidate] of entries.slice(0, limit).entries()) {
      const entry = record(candidate) ? candidate : {};
      const sourceId = typeof entry.sourceId === "string" ? entry.sourceId : null;
      const source = sourceId === "draft" ? document : sourceId ? sources.get(sourceId) : undefined;
      const draft = quotation(document, entry.draftQuote), existing = quotation(source, entry.existingQuote);
      const errors: string[] = [];
      const text = (field: unknown, size: number) => typeof field === "string" && field.trim().length > 0 && field.length <= size;
      if (!record(candidate) || Object.keys(entry).some(key => !["sourceId", "draftQuote", "existingQuote", "explanation"].includes(key))
        || !text(entry.sourceId, 256) || !text(entry.draftQuote, 4000) || !text(entry.existingQuote, 4000)
        || !text(entry.explanation, kind === "conflict" ? 2000 : 1000)) {
        schemaValid = false; errors.push("invalid-fields");
      }
      if (!source) errors.push("unknown-source");
      for (const [side, quote] of [["draft", draft], ["existing", existing]] as const) {
        if (quote.matches === 0) errors.push(`${side}:not-found`);
        else if (quote.matches !== null && quote.matches > 1) errors.push(`${side}:ambiguous`);
        else if (quote.matches === null && (side === "draft" || source)) errors.push(`${side}:invalid-quote`);
      }
      if (sourceId === "draft" && draft.matches === 1 && existing.matches === 1) {
        const sourceText = normalize(document.text), left = sourceText.indexOf(normalize(draft.quote!)), right = sourceText.indexOf(normalize(existing.quote!));
        if (Math.max(left, right) < Math.min(left + normalize(draft.quote!).length, right + normalize(existing.quote!).length)) errors.push("internal-overlap");
      }
      findings.push({ kind, index: index + 1, sourceId, valid: errors.length === 0, errors, draft, existing });
    }
  }
  return { jsonValid: true, schemaValid, proposedConflicts: value.conflicts.length,
    proposedUncertainties: value.uncertainties.length, findings };
}
