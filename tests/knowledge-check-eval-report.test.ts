import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { knowledgeEvalCases } from "../scripts/knowledge-check-eval/cases.js";
import { summarizeKnowledgeEval, writeKnowledgeEvalReport, type KnowledgeEvalReport, type KnowledgeEvalRun } from "../scripts/knowledge-check-eval/report.js";
import { scoreKnowledgeEval } from "../scripts/knowledge-check-eval/scoring.js";
import type { EvalCallRecord } from "../scripts/knowledge-check-eval/runtime.js";

const fixture = knowledgeEvalCases[0]!;
const report = (extra: Partial<KnowledgeEvalReport> = {}): KnowledgeEvalReport => ({
  version: 1, startedAt: "2026-10-30T16:00:00.000Z", model: { modelRef: "fixture/model" },
  thinking: "low", source: {}, maxCalls: 24, plannedCalls: 3, plannedCases: { judge: 2, retrieval: 1 },
  runs: [], requests: [], ...extra,
});
const run = (extra: Partial<KnowledgeEvalRun> = {}): KnowledgeEvalRun => ({
  id: fixture.id, title: fixture.title, stage: "judge", repetition: 1, expected: "conflict",
  expectedConflictPairs: 1, passed: false, requestIds: [], elapsedMs: 1, ...extra,
});
const request = (id: number, rawText: string, error?: string): EvalCallRecord => ({
  id, caseId: `judge/${fixture.id}/1`, elapsedMs: 1,
  prompt: { system: "fixture", user: JSON.stringify({ draft: fixture.document, sources: fixture.evidence }) },
  rawText, ...(error !== undefined ? { error } : {}),
});
const clean = JSON.stringify({ conflicts: [], uncertainties: [] });
const rawFinding = { sourceId: fixture.evidence[0]!.id, draftQuote: fixture.expectedPairs[0]!.draftAnchor,
  existingQuote: fixture.expectedPairs[0]!.existingAnchor, explanation: "Для одинаковых условий заданы разные точные значения." };

async function output(t: TestContext): Promise<string> {
  const artifacts = fileURLToPath(new URL("../.pi/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "knowledge-eval-report-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("live eval report counts", () => {
  it("retains planned denominators before any case has completed", () => {
    const summary = summarizeKnowledgeEval(report());
    assert.deepEqual(summary.total, { planned: 3, passed: 0, failed: 0, notRun: 0, pending: 3 });
    assert.deepEqual(summary.judge, { planned: 2, passed: 0, failed: 0, notRun: 0, pending: 2 });
    assert.deepEqual(summary.retrieval, { planned: 1, passed: 0, failed: 0, notRun: 0, pending: 1 });
  });

  it("separates completed failures, explicit not-run cases and pending work", () => {
    const initial = summarizeKnowledgeEval(report({ runs: [run({ passed: true })] }));
    assert.equal(initial.total.planned, 3); assert.equal(initial.total.pending, 2);
    const final = summarizeKnowledgeEval(report({ runs: [run({ passed: true }),
      run({ stage: "retrieval", error: "Native search unavailable" }), run({ notRun: true, error: "Stopped" })] }));
    assert.deepEqual(final.total, { planned: 3, passed: 1, failed: 1, notRun: 1, pending: 0 });
    assert.deepEqual(final.judge, { planned: 2, passed: 1, failed: 0, notRun: 1, pending: 0 });
    assert.deepEqual(final.retrieval, { planned: 1, passed: 0, failed: 1, notRun: 0, pending: 0 });
  });

  it("never reports negative pending counts for an inconsistent caller plan", () => {
    const summary = summarizeKnowledgeEval(report({ plannedCases: { judge: 0, retrieval: 0 }, runs: [run()] }));
    assert.equal(summary.total.pending, 0); assert.equal(summary.judge.pending, 0);
  });

  it("counts completed empty text as invalid while keeping provider errors separate", () => {
    const providerText = JSON.stringify({ conflicts: [rawFinding], uncertainties: [] });
    const summary = summarizeKnowledgeEval(report({ requests: [request(1, clean), request(2, ""),
      request(3, providerText, "Provider failed after partial output"), request(4, "", "")] }));
    assert.equal(summary.modelCalls, 4); assert.equal(summary.providerErrors, 2);
    assert.deepEqual(summary.responses, { total: 2, validJson: 1, validSchema: 1 });
    assert.equal(summary.proposedFindings, 0);
    assert.equal(summary.diagnostics.length, 4);
    assert.equal(summary.diagnostics[1]!.diagnostic.jsonValid, false);
    assert.equal(summary.diagnostics[2]!.providerError, "Provider failed after partial output");
    assert.equal(summary.diagnostics[2]!.diagnostic.findings[0]!.valid, true);
  });

  it("retains quote rejection diagnostics even when no grounded finding survives", () => {
    const raw = JSON.stringify({ conflicts: [{ ...rawFinding, existingQuote: "Invented quotation." }], uncertainties: [] });
    const summary = summarizeKnowledgeEval(report({ requests: [request(1, raw)] }));
    assert.equal(summary.responses.validJson, 1); assert.equal(summary.responses.validSchema, 1);
    assert.equal(summary.proposedFindings, 1); assert.equal(summary.validFindings, 0); assert.equal(summary.rejectedQuotes, 1);
    assert.equal(summary.diagnostics[0]!.diagnostic.findings[0]!.existing.quote, "Invented quotation.");
  });

  it("reports pair quality only for scored judge responses while other failures stay explicit", () => {
    const score = scoreKnowledgeEval(fixture, { complete: true, notices: [], uncertainties: [], conflicts: [{
      draft: { path: fixture.document.path, quote: rawFinding.draftQuote, startLine: 2, endLine: 2 },
      existing: { path: fixture.evidence[0]!.path, quote: rawFinding.existingQuote, startLine: 8, endLine: 8 },
      explanation: rawFinding.explanation,
    }] });
    const summary = summarizeKnowledgeEval(report({ runs: [run({ passed: true, score }),
      run({ error: "Provider failed" }), run({ stage: "retrieval", notRun: true })], requests: [request(1, "", "Provider failed")] }));
    assert.deepEqual(summary.pairMetrics, { truePositivePairs: 1, falsePositivePairs: 0, missedPairs: 0, precision: 1, recall: 1 });
    assert.deepEqual(summary.total, { planned: 3, passed: 1, failed: 1, notRun: 1, pending: 0 });
    assert.equal(summary.providerErrors, 1);
  });
});

describe("atomic live eval reports", () => {
  it("replaces complete reports, links padded request filenames and leaves no temporary files", async t => {
    const directory = await output(t);
    await writeKnowledgeEvalReport(directory, report());
    const before = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    assert.equal(before.summary.total.pending, 3);
    await writeKnowledgeEvalReport(directory, report({ finishedAt: "2026-10-30T16:01:00.000Z",
      runs: [run({ requestIds: [1, 12], error: "Unvalidated quotes" })] }));
    const after = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    assert.equal(after.finishedAt, "2026-10-30T16:01:00.000Z");
    assert.equal(after.summary.total.planned, 3); assert.equal(after.summary.total.pending, 2);
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    assert.match(markdown, /0\/3 passed; 1 failed; 0 not run; 2 pending/u);
    assert.ok(markdown.includes("[call-0001.json](requests/call-0001.json)"));
    assert.ok(markdown.includes("[call-0012.json](requests/call-0012.json)"));
    assert.ok(!markdown.includes("call-N.json"));
    assert.deepEqual((await readdir(directory)).sort(), ["report.json", "report.md"]);
    assert.equal((await stat(join(directory, "report.json"))).mode & 0o777, 0o600);
  });

  it("cleans only its temporary file after a failed rename and preserves existing destinations", async t => {
    const directory = await output(t);
    await mkdir(join(directory, "report.json"));
    await writeFile(join(directory, "report.json", "keep.txt"), "keep");
    await writeFile(join(directory, "report.md"), "previous complete markdown");
    await assert.rejects(writeKnowledgeEvalReport(directory, report()));
    assert.equal(await readFile(join(directory, "report.json", "keep.txt"), "utf8"), "keep");
    assert.equal(await readFile(join(directory, "report.md"), "utf8"), "previous complete markdown");
    assert.deepEqual((await readdir(directory)).sort(), ["report.json", "report.md"]);
  });
});
