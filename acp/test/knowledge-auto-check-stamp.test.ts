import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckResult } from "../src/knowledge/contract.js";
import { KNOWLEDGE_REPORT_PREFIX, KNOWLEDGE_STAMP_PREFIX, MAX_KNOWLEDGE_STAMP_BYTES,
  knowledgeEvidenceText, readKnowledgeAutoCheckAttempt, readKnowledgeCheckStamp, readKnowledgeReport,
  recordKnowledgeAutoCheckAttempt, recordKnowledgeCheck, stripKnowledgeCheckStamp } from "../src/knowledge/stamp.js";

const runId = "aa000000-0000-4000-8000-000000000001";
const nextRunId = "aa000000-0000-4000-8000-000000000002";
const checkedAt = "2026-10-30T12:34:56.789Z";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const body = "\uFEFF---\r\nstatus: active\r\n---\r\n# Правила\r\nПрикрытие круговое.\r\n";
const result = (content: string, status: KnowledgeCheckResult["status"] = "incomplete"): KnowledgeCheckResult => ({
  status, path: "wiki/rules.md", documentHash: hash(content), modelRef: "test/judge", reportLanguage: "ru",
  checkedSources: 1, conflicts: [], notices: status === "clear" ? [] : ["Не хватает контекста."],
});

test("automatic checkpoint survives restart without becoming a green check or changing exact body bytes", async () => {
  const saved = await recordKnowledgeAutoCheckAttempt(body, runId, hash(body), checkedAt);
  assert.deepEqual(await readKnowledgeAutoCheckAttempt(saved), {
    version: 1, status: "attempted", runId, contentHash: hash(body), checkedAt, current: true,
    maxDocumentChars: MAX_KNOWLEDGE_DOCUMENT_CHARS,
  });
  assert.equal(stripKnowledgeCheckStamp(saved), body);
  assert.equal(await readKnowledgeCheckStamp(saved), undefined);
  assert.equal(await readKnowledgeReport(saved), undefined);
  assert.ok(new TextEncoder().encode(saved.slice(body.length)).byteLength < MAX_KNOWLEDGE_STAMP_BYTES);
});

test("legacy checkpoints without a document cap remain readable but distinguishable", async () => {
  const checkpoint = { version: 1, status: "attempted", runId, contentHash: hash(body), checkedAt };
  const saved = body + "\n" + KNOWLEDGE_STAMP_PREFIX + JSON.stringify(checkpoint) + " -->\n";
  assert.deepEqual(await readKnowledgeAutoCheckAttempt(saved), { ...checkpoint, current: true });
  assert.equal(await readKnowledgeCheckStamp(saved), undefined);
  assert.equal(stripKnowledgeCheckStamp(saved), body);
  const replaced = await recordKnowledgeAutoCheckAttempt(saved, runId, hash(body), checkedAt);
  assert.equal((await readKnowledgeAutoCheckAttempt(replaced))?.maxDocumentChars, MAX_KNOWLEDGE_DOCUMENT_CHARS);
  assert.equal(replaced.split(KNOWLEDGE_STAMP_PREFIX).length - 1, 1);
});

test("checkpoint document caps are optional positive bounded integers, never arbitrary fields", async () => {
  for (const cap of [null, "128000", 0, -1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER]) {
    const checkpoint = { version: 1, status: "attempted", runId, contentHash: hash(body), checkedAt, maxDocumentChars: cap };
    const saved = body + "\n" + KNOWLEDGE_STAMP_PREFIX + JSON.stringify(checkpoint) + " -->\n";
    assert.equal(await readKnowledgeAutoCheckAttempt(saved), undefined);
  }
  for (const maxDocumentChars of [48_000, MAX_KNOWLEDGE_DOCUMENT_CHARS, 1_000_000]) {
    const checkpoint = { version: 1, status: "attempted", runId, contentHash: hash(body), checkedAt, maxDocumentChars };
    const saved = body + "\n" + KNOWLEDGE_STAMP_PREFIX + JSON.stringify(checkpoint) + " -->\n";
    assert.equal((await readKnowledgeAutoCheckAttempt(saved))?.maxDocumentChars, maxDocumentChars);
  }
});

test("a failed automatic attempt preserves the prior report bytes and its stale hash", async () => {
  const old = await recordKnowledgeCheck(body, result(body), checkedAt);
  const edited = old.replace("Прикрытие круговое.", "Прикрытие направленное.");
  const currentBody = stripKnowledgeCheckStamp(edited);
  const saved = await recordKnowledgeAutoCheckAttempt(edited, runId, hash(currentBody), checkedAt);
  assert.ok(saved.startsWith(edited));
  assert.deepEqual(await readKnowledgeReport(saved), { result: result(body), checkedAt, current: false });
  assert.equal((await readKnowledgeAutoCheckAttempt(saved))?.current, true);
  assert.equal(stripKnowledgeCheckStamp(saved), currentBody);
});

test("nonclear report and checkpoint remain independently readable, with metadata excluded from evidence", async () => {
  const report = await recordKnowledgeCheck(body, result(body), checkedAt);
  const saved = await recordKnowledgeAutoCheckAttempt(report, runId, hash(body), checkedAt);
  assert.equal((await readKnowledgeReport(saved))?.current, true);
  assert.equal((await readKnowledgeAutoCheckAttempt(saved))?.current, true);
  assert.equal(stripKnowledgeCheckStamp(saved), body);
  const evidence = knowledgeEvidenceText(saved);
  assert.equal(evidence.includes(runId), false);
  assert.equal(evidence.includes(KNOWLEDGE_REPORT_PREFIX), false);
  assert.equal(evidence.includes(KNOWLEDGE_STAMP_PREFIX), false);
  assert.equal(evidence.match(/[\r\n]/gu)?.join(""), saved.match(/[\r\n]/gu)?.join(""));
});

test("new pass replaces the checkpoint, and a successful check removes both report and attempt", async () => {
  const first = await recordKnowledgeAutoCheckAttempt(await recordKnowledgeCheck(body, result(body), checkedAt), runId, hash(body), checkedAt);
  const second = await recordKnowledgeAutoCheckAttempt(first, nextRunId, hash(body), checkedAt);
  assert.equal((await readKnowledgeAutoCheckAttempt(second))?.runId, nextRunId);
  assert.equal(second.split(KNOWLEDGE_STAMP_PREFIX).length - 1, 1);
  assert.equal(second.includes(runId), false);
  const clear = await recordKnowledgeCheck(second, result(body, "clear"), checkedAt);
  assert.equal(await readKnowledgeAutoCheckAttempt(clear), undefined);
  assert.equal(await readKnowledgeReport(clear), undefined);
  assert.equal((await readKnowledgeCheckStamp(clear))?.contentHash, hash(body));
  assert.equal(stripKnowledgeCheckStamp(clear), body);
});

test("logical changes invalidate the checkpoint; fresh timestamps and report-only changes do not", async () => {
  const checkpoint = await recordKnowledgeAutoCheckAttempt(body, runId, hash(body), checkedAt);
  assert.equal((await readKnowledgeAutoCheckAttempt(checkpoint.replace("Прикрытие", "Обзор")))?.current, false);
  const changedMetadata = await recordKnowledgeAutoCheckAttempt(checkpoint, runId, hash(body), "2026-10-30T12:35:00.000Z");
  assert.equal((await readKnowledgeAutoCheckAttempt(changedMetadata))?.current, true);
  assert.equal(stripKnowledgeCheckStamp(changedMetadata), body);
});

test("invalid, forged and duplicate checkpoint fields do not authorize skipping a version", async () => {
  const valid = await recordKnowledgeAutoCheckAttempt(body, runId, hash(body), checkedAt);
  for (const invalid of [
    valid.replace('"attempted"', '"clear"'),
    valid.replace(runId, "not-a-pass"),
    valid.replace(checkedAt, "2026-02-30T12:34:56.789Z"),
    valid.replace('"version":1', '"version":2'),
    valid.replace('"version":1', '"version":1,"extra":true'),
    valid + valid.slice(body.length),
    body + "\n" + KNOWLEDGE_STAMP_PREFIX + "x".repeat(MAX_KNOWLEDGE_STAMP_BYTES) + " -->\n",
  ]) {
    assert.equal(await readKnowledgeAutoCheckAttempt(invalid), undefined);
    assert.equal(await readKnowledgeCheckStamp(invalid), undefined);
  }
  await assert.rejects(recordKnowledgeAutoCheckAttempt(body, runId, "0".repeat(64), checkedAt));
  await assert.rejects(recordKnowledgeAutoCheckAttempt(body, "<script>", hash(body), checkedAt));
  await assert.rejects(recordKnowledgeAutoCheckAttempt(body, runId, hash(body), "yesterday"));
});
