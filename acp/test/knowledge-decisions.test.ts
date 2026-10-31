import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { KnowledgeCheckResult } from "../src/knowledge/contract.js";
import { isKnowledgeFindingDecision, knowledgeFindingId, knowledgeFindingSides } from "../src/knowledge/decisions.js";
import {
  KNOWLEDGE_REPORT_PREFIX, preserveKnowledgeReport, readKnowledgeReport, recordKnowledgeAutoCheckAttempt,
  recordKnowledgeCheck, recordKnowledgeDecision, stripKnowledgeCheckStamp,
} from "../src/knowledge/stamp.js";

const checkedAt = "2026-10-30T12:34:56.789Z";
const decidedAt = "2026-10-30T13:00:00.000Z";
const body = "---\ntitle: Policy\n---\n# Policy\nDraft claim.\n";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const draft = { path: "wiki/policy.md", quote: "Draft claim.", startLine: 5, endLine: 5 };
const existing = { path: "wiki/rules.md", quote: "Source claim.", startLine: 8, endLine: 8 };
const other = { path: "wiki/other.md", quote: "Other claim.", startLine: 2, endLine: 2 };

function result(content: string, changes: Partial<KnowledgeCheckResult> = {}): KnowledgeCheckResult {
  return { status: "conflicts", path: draft.path, documentHash: hash(content), modelRef: "test/model", reportLanguage: "ru",
    checkedSources: 2, conflicts: [{ draft, existing, explanation: "Несовместимые правила." }],
    uncertainties: [{ draft, existing: other, explanation: "Не определена область." }], notices: [], ...changes };
}

test("finding identity and side order do not depend on the reporting page", async () => {
  assert.equal(await knowledgeFindingId("conflict", draft, existing), await knowledgeFindingId("conflict", existing, draft));
  assert.notEqual(await knowledgeFindingId("conflict", draft, existing), await knowledgeFindingId("uncertainty", draft, existing));
  assert.deepEqual(knowledgeFindingSides(existing, draft), [draft, existing]);
});

test("records, replaces and clears one decision without touching body bytes or trailing metadata", async () => {
  const id = await knowledgeFindingId("conflict", draft, existing);
  const saved = await recordKnowledgeAutoCheckAttempt(await recordKnowledgeCheck(body, result(body), checkedAt),
    "12345678-1234-1234-1234-123456789abc", hash(body), checkedAt);
  const decided = await recordKnowledgeDecision(saved, id, { verdict: "false-positive", note: "Разные режимы.", at: decidedAt });
  assert.equal(stripKnowledgeCheckStamp(decided), body);
  assert.ok(decided.endsWith(saved.slice(saved.lastIndexOf("\n<!-- pix:wiki-check "))));
  const report = await readKnowledgeReport(decided);
  assert.equal(report?.current, true);
  assert.equal(report?.checkedAt, checkedAt);
  assert.deepEqual(report?.decisions, [{ findingId: id, verdict: "false-positive", note: "Разные режимы.", at: decidedAt }]);

  const replaced = await recordKnowledgeDecision(decided, id, { verdict: "deferred", at: decidedAt });
  assert.deepEqual((await readKnowledgeReport(replaced))?.decisions, [{ findingId: id, verdict: "deferred", at: decidedAt }]);
  const cleared = await recordKnowledgeDecision(replaced, id, null);
  assert.equal(cleared, saved);
  assert.equal((await readKnowledgeReport(cleared))?.decisions, undefined);
});

test("rejects decisions for unknown findings, missing reports and invalid notes", async () => {
  const saved = await recordKnowledgeCheck(body, result(body), checkedAt);
  const id = await knowledgeFindingId("conflict", draft, existing);
  await assert.rejects(recordKnowledgeDecision(saved, "0".repeat(64), { verdict: "deferred", at: decidedAt }), /no longer contains/u);
  await assert.rejects(recordKnowledgeDecision(body, id, { verdict: "deferred", at: decidedAt }), /no valid saved/u);
  await assert.rejects(recordKnowledgeDecision(saved, id, { verdict: "false-positive", at: decidedAt }), /invalid/u);
  await assert.rejects(recordKnowledgeDecision(saved, id, { verdict: "deferred", note: " padded ", at: decidedAt }), /invalid/u);
  assert.equal(isKnowledgeFindingDecision({ findingId: id, verdict: "side-a", at: "2026-10-30" }), false);
  assert.equal(isKnowledgeFindingDecision({ findingId: id, verdict: "side-a", at: decidedAt, extra: 1 }), false);
});

test("a deferred decision may link one project task; other verdicts and malformed ids are rejected", async () => {
  const saved = await recordKnowledgeCheck(body, result(body), checkedAt);
  const id = await knowledgeFindingId("conflict", draft, existing);
  const taskId = "12345678-1234-1234-1234-123456789abc";
  const linked = await recordKnowledgeDecision(saved, id, { verdict: "deferred", taskId, at: decidedAt });
  assert.deepEqual((await readKnowledgeReport(linked))?.decisions, [{ findingId: id, verdict: "deferred", taskId, at: decidedAt }]);
  await assert.rejects(recordKnowledgeDecision(saved, id, { verdict: "side-a", taskId, at: decidedAt }), /invalid/u);
  for (const bad of ["", "../x", "a b", "x".repeat(129)]) {
    assert.equal(isKnowledgeFindingDecision({ findingId: id, verdict: "deferred", taskId: bad, at: decidedAt }), false);
  }
});

test("a recheck carries decisions only for findings it still reports; preserve keeps them on unreviewed saves", async () => {
  const conflictId = await knowledgeFindingId("conflict", draft, existing);
  const uncertaintyId = await knowledgeFindingId("uncertainty", draft, other);
  let saved = await recordKnowledgeCheck(body, result(body), checkedAt);
  saved = await recordKnowledgeDecision(saved, conflictId, { verdict: "side-a", at: decidedAt });
  saved = await recordKnowledgeDecision(saved, uncertaintyId, { verdict: "deferred", at: decidedAt });

  const edited = body.replace("# Policy", "# Policy v2");
  const preserved = await preserveKnowledgeReport(edited, saved);
  const kept = await readKnowledgeReport(preserved);
  assert.equal(kept?.current, false);
  assert.equal(kept?.decisions?.length, 2);

  // The recheck no longer reports the uncertainty; line numbers moved but quotes did not.
  const moved = { ...draft, startLine: 6, endLine: 6 };
  const next = result(edited, { conflicts: [{ draft: moved, existing, explanation: "Снова." }], uncertainties: [] });
  const rechecked = await recordKnowledgeCheck(edited, next, decidedAt, preserved);
  assert.deepEqual((await readKnowledgeReport(rechecked))?.decisions, [{ findingId: conflictId, verdict: "side-a", at: decidedAt }]);

  const dropped = await recordKnowledgeCheck(edited, result(edited, { conflicts: [{ draft, existing: other, explanation: "Новое." }],
    uncertainties: [] }), decidedAt, preserved);
  assert.equal((await readKnowledgeReport(dropped))?.decisions, undefined);
  assert.equal(dropped.split(KNOWLEDGE_REPORT_PREFIX).length - 1, 1);
});

test("rejects malformed decision lists in a saved envelope", async () => {
  const id = await knowledgeFindingId("conflict", draft, existing);
  const envelope = (decisions: unknown) => KNOWLEDGE_REPORT_PREFIX
    + JSON.stringify({ version: 1, checkedAt, result: result(body), decisions }) + " -->\n" + body;
  const decision = { findingId: id, verdict: "deferred", at: decidedAt };
  assert.ok(await readKnowledgeReport(envelope([decision])));
  for (const invalid of [[], [decision, decision], [{ ...decision, verdict: "maybe" }], "x"]) {
    assert.equal(await readKnowledgeReport(envelope(invalid)), undefined);
  }
});
