import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComparisonResult, KnowledgeConflict } from "../acp/src/knowledge/comparison.js";
import type { KnowledgeCheckResult } from "../acp/src/knowledge/contract.js";
import { MAX_KNOWLEDGE_CHUNK_CHARS, MAX_KNOWLEDGE_DOCUMENT_CHARS } from "../acp/src/knowledge/contract.js";
import { reportMessage } from "../acp/src/knowledge/report-language.js";
import { knowledgeEvalCases, type KnowledgeEvalCase } from "../scripts/knowledge-check-eval/cases.js";
import { diagnoseKnowledgeResponse, scoreKnowledgeEval } from "../scripts/knowledge-check-eval/scoring.js";

const fixture = (id: string) => {
  const found = knowledgeEvalCases.find(item => item.id === id);
  assert.ok(found, `missing fixture ${id}`);
  return found;
};
const normalize = (text: string) => text.replace(/\r\n?/gu, "\n");
const clean = (): ComparisonResult => ({ conflicts: [], uncertainties: [], notices: [], complete: true });
function finding(item: KnowledgeEvalCase, extra: Partial<KnowledgeConflict> = {}): KnowledgeConflict {
  const pair = item.expectedPairs[0]!;
  return { draft: { path: item.document.path, quote: pair.draftAnchor, startLine: 1, endLine: 1 },
    existing: { path: pair.sourcePath, quote: pair.existingAnchor, startLine: 1, endLine: 1 },
    explanation: "Два утверждения относятся к одинаковым условиям.", ...extra };
}
function response(item = fixture("exact-number"), overrides: Record<string, unknown> = {}) {
  const pair = item.expectedPairs[0]!;
  return JSON.stringify({ conflicts: [{ sourceId: "source-1", draftQuote: pair.draftAnchor,
    existingQuote: pair.existingAnchor, explanation: "В одинаковых условиях заданы несовместимые точные значения.", ...overrides }], uncertainties: [] });
}

describe("synthetic contradiction eval fixtures", () => {
  it("keeps a balanced, uniquely identified matrix with bounded project-local evidence", () => {
    assert.equal(knowledgeEvalCases.length, 16);
    assert.equal(new Set(knowledgeEvalCases.map(item => item.id)).size, 16);
    assert.deepEqual(Object.fromEntries(["conflict", "clear", "uncertain"].map(label =>
      [label, knowledgeEvalCases.filter(item => item.expected === label).length])), { conflict: 9, clear: 6, uncertain: 1 });
    for (const item of knowledgeEvalCases) {
      const safe = (path: string) => path.startsWith("wiki/") && path.endsWith(".md")
        && !/[\\\u0000-\u001f\u007f:]/u.test(path) && path.split("/").every(part => part && !part.startsWith("."));
      assert.ok(safe(item.document.path), item.id);
      assert.ok(item.document.text.length <= MAX_KNOWLEDGE_DOCUMENT_CHARS);
      assert.ok(!item.document.text.includes("\0"));
      assert.equal(new Set(item.evidence.map(source => source.id)).size, item.evidence.length);
      for (const source of item.evidence) {
        assert.ok(safe(source.path)); assert.ok(source.id !== "draft" && source.id.length > 0);
        assert.ok(Number.isSafeInteger(source.startLine) && source.startLine > 0);
        assert.ok(!source.text.includes("\0"));
      }
      assert.equal(item.expectedPairs.length, item.expected === "clear" ? 0 : 1);
    }
  });

  it("grounds every gold anchor in actual text, including the unique repeated-quote context", () => {
    for (const item of knowledgeEvalCases) for (const pair of item.expectedPairs) {
      assert.ok(normalize(item.document.text).includes(normalize(pair.draftAnchor)), item.id);
      const sourceText = pair.sourcePath === item.document.path ? item.document.text
        : item.evidence.find(source => source.path === pair.sourcePath)?.text;
      assert.ok(sourceText && normalize(sourceText).includes(normalize(pair.existingAnchor)), item.id);
      assert.equal(pair.outcome, item.expected);
    }
    const repeated = fixture("repeated-quote");
    assert.equal(repeated.document.text.split("Размер отряда: ровно 4 бойца.").length - 1, 2);
    assert.equal(repeated.document.text.split(repeated.expectedPairs[0]!.draftAnchor).length - 1, 1);
  });

  it("puts the long positive claims in distant parts while ordinary cases fit one draft", () => {
    const long = fixture("cross-chunk");
    assert.equal(long.chunked, true);
    assert.ok(long.document.text.length > MAX_KNOWLEDGE_CHUNK_CHARS);
    assert.ok(long.document.text.length <= 2 * MAX_KNOWLEDGE_CHUNK_CHARS);
    assert.ok(long.document.text.indexOf(long.expectedPairs[0]!.draftAnchor) < 1000);
    assert.ok(long.document.text.indexOf(long.expectedPairs[0]!.existingAnchor) > MAX_KNOWLEDGE_CHUNK_CHARS);
    for (const item of knowledgeEvalCases.filter(item => !item.chunked)) assert.ok(item.document.text.length <= MAX_KNOWLEDGE_CHUNK_CHARS);
  });
});

describe("contradiction eval scorer", () => {
  it("accepts longer original quotations containing the required claims", () => {
    const item = fixture("exact-number");
    const pair = finding(item, {
      draft: { path: item.document.path, quote: item.document.text, startLine: 1, endLine: 2 },
      existing: { path: item.evidence[0]!.path, quote: item.evidence[0]!.text, startLine: 7, endLine: 8 },
    });
    const result = scoreKnowledgeEval(item, { ...clean(), conflicts: [pair] });
    assert.equal(result.passed, true); assert.equal(result.classActual, "conflict");
    assert.deepEqual(result.missingPairs, []); assert.deepEqual(result.unexpectedPairs, []);
  });

  it("never awards a clean negative when proposed findings were rejected", () => {
    const result = scoreKnowledgeEval(fixture("different-mode"), {
      ...clean(), complete: false, notices: ["Finding 1 could not be validated: a quotation is missing."] });
    assert.equal(result.passed, false); assert.equal(result.classActual, "incomplete");
    assert.equal(result.technicalIncomplete, true);
  });

  it("distinguishes legitimate grounded uncertainty from a technical failure", () => {
    const item = fixture("missing-scope");
    const result = scoreKnowledgeEval(item, { ...clean(), uncertainties: [finding(item)], complete: false });
    assert.equal(result.passed, true); assert.equal(result.classActual, "uncertain");
    assert.equal(result.technicalIncomplete, false);
  });

  it("rejects a positive label with an incorrect source or wrong paired claim", () => {
    const item = fixture("exact-number"), pair = finding(item);
    for (const existing of [{ ...pair.existing, path: "wiki/another.md" }, { ...pair.existing, quote: "Different claim." }]) {
      const result = scoreKnowledgeEval(item, { ...clean(), conflicts: [{ ...pair, existing }] });
      assert.equal(result.classActual, "conflict"); assert.equal(result.passed, false);
      assert.equal(result.missingPairs.length, 1); assert.equal(result.unexpectedPairs[0]!.reason, "wrong-pair");
    }
  });

  it("rejects extra incorrect uncertainties even when the expected conflict is present", () => {
    const item = fixture("exact-number"), pair = finding(item);
    const result = scoreKnowledgeEval(item, { ...clean(), conflicts: [pair], uncertainties: [pair], complete: false });
    assert.equal(result.passed, false); assert.equal(result.missingPairs.length, 0);
    assert.equal(result.unexpectedPairs[0]!.outcome, "uncertain");
  });

  it("matches an internal pair in either orientation but flags duplicate findings", () => {
    const item = fixture("internal"), pair = finding(item);
    const reversed = { ...pair, draft: pair.existing, existing: pair.draft };
    assert.equal(scoreKnowledgeEval(item, { ...clean(), conflicts: [reversed] }).passed, true);
    const duplicate = scoreKnowledgeEval(item, { ...clean(), conflicts: [pair, reversed] });
    assert.equal(duplicate.passed, false); assert.equal(duplicate.unexpectedPairs.length, 1);
    assert.equal(duplicate.unexpectedPairs[0]!.reason, "duplicate");
  });

  it("does not pass a partial chunk result merely because it retained a correct conflict", () => {
    const item = fixture("cross-chunk");
    const result: KnowledgeCheckResult = { status: "conflicts", path: item.document.path,
      documentHash: "a".repeat(64), modelRef: "fixture/model", checkedSources: 1,
      conflicts: [finding(item)], uncertainties: [], notices: [],
      chunkCoverage: { totalChunks: 2, checkedChunks: 1, totalComparisons: 3, checkedComparisons: 1 } };
    const score = scoreKnowledgeEval(item, result);
    assert.equal(score.passed, false); assert.equal(score.classActual, "conflict");
    assert.equal(score.technicalIncomplete, true);
  });

  it("does not confuse bounded source display with missing comparison work", () => {
    const item = fixture("different-mode");
    const result: KnowledgeCheckResult = { status: "clear", path: item.document.path,
      documentHash: "a".repeat(64), modelRef: "fixture/model", checkedSources: 1,
      conflicts: [], uncertainties: [], notices: [reportMessage("ru", "reviewedSourcesSampled")] };
    assert.equal(scoreKnowledgeEval(item, result).passed, true);
  });
});

describe("raw model quote diagnostics", () => {
  it("distinguishes malformed JSON, malformed schema and malformed finding fields", () => {
    const item = fixture("exact-number");
    assert.equal(diagnoseKnowledgeResponse("not JSON", item.document, item.evidence).jsonValid, false);
    const schema = diagnoseKnowledgeResponse('{"conflicts":[]}', item.document, item.evidence);
    assert.equal(schema.jsonValid, true); assert.equal(schema.schemaValid, false);
    const fields = diagnoseKnowledgeResponse(response(item, { explanation: "" }), item.document, item.evidence);
    assert.equal(fields.schemaValid, false); assert.ok(fields.findings[0]!.errors.includes("invalid-fields"));
  });

  it("retains the missing side, source path and exact untrusted quotation", () => {
    const item = fixture("exact-number"), quote = "Модель перефразировала исходную цитату.";
    const result = diagnoseKnowledgeResponse(response(item, { existingQuote: quote }), item.document, item.evidence);
    assert.equal(result.jsonValid, true); assert.equal(result.schemaValid, true);
    assert.equal(result.proposedConflicts, 1); assert.equal(result.findings[0]!.valid, false);
    assert.deepEqual(result.findings[0]!.existing, { path: item.evidence[0]!.path, quote, matches: 0 });
    assert.equal(result.findings[0]!.draft.matches, 1);
    assert.deepEqual(result.findings[0]!.errors, ["existing:not-found"]);
  });

  it("separates repeated quotations from missing quotations", () => {
    const item = fixture("repeated-quote");
    const result = diagnoseKnowledgeResponse(response(item, { draftQuote: "Размер отряда: ровно 4 бойца." }), item.document, item.evidence);
    assert.equal(result.findings[0]!.draft.matches, 2);
    assert.deepEqual(result.findings[0]!.errors, ["draft:ambiguous"]);
    const unique = diagnoseKnowledgeResponse(response(item), item.document, item.evidence);
    assert.equal(unique.findings[0]!.valid, true);
  });

  it("normalizes CRLF identically to production and excludes context-only quotation evidence", () => {
    const item = fixture("markdown-crlf");
    const valid = diagnoseKnowledgeResponse(response(item, { draftQuote: normalize(item.document.text) }), item.document, item.evidence);
    assert.equal(valid.findings[0]!.valid, true);
    const context = "Context-only claim.";
    const invalid = diagnoseKnowledgeResponse(response(item, { existingQuote: context }), item.document,
      [{ ...item.evidence[0]!, context }]);
    assert.deepEqual(invalid.findings[0]!.errors, ["existing:not-found"]);
  });

  it("does not invent a path for a model-created source identifier", () => {
    const item = fixture("exact-number");
    const result = diagnoseKnowledgeResponse(response(item, { sourceId: "../../private" }), item.document, item.evidence);
    assert.equal(result.findings[0]!.existing.path, null);
    assert.equal(result.findings[0]!.existing.matches, null);
    assert.ok(result.findings[0]!.errors.includes("unknown-source"));
  });

  it("detects overlapping internal quotations and accepts ordinary JSON fences", () => {
    const item = fixture("internal");
    const quote = item.expectedPairs[0]!.draftAnchor;
    const raw = response(item, { sourceId: "draft", draftQuote: quote, existingQuote: quote });
    const result = diagnoseKnowledgeResponse("```json\n" + raw + "\n```", item.document, item.evidence);
    assert.equal(result.jsonValid, true); assert.equal(result.findings[0]!.valid, false);
    assert.deepEqual(result.findings[0]!.errors, ["internal-overlap"]);
  });
});
