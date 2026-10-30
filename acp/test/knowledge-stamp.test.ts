import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { KnowledgeCheckResult } from "../src/knowledge/contract.js";
import { KNOWLEDGE_STAMP_PREFIX, knowledgeEvidenceText, MAX_KNOWLEDGE_STAMP_BYTES,
  readKnowledgeCheckStamp, stampKnowledgeCheck, stripKnowledgeCheckStamp } from "../src/knowledge/stamp.js";

const checkedAt = "2026-10-30T12:34:56.789Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function result(body: string, changes: Partial<KnowledgeCheckResult> = {}): KnowledgeCheckResult {
  return { status: "clear", path: "wiki/policy.md", documentHash: hash(body), modelRef: "test/model", checkedSources: 2,
    reportLanguage: "ru", coverage: { scope: "retrieved-passages", checkedPassages: 2, candidateSources: 7,
      excerptedSources: 0, limits: [] }, conflicts: [], notices: [], ...changes };
}

test("saved checks preserve body bytes for LF, CRLF, frontmatter and absent final newlines", async () => {
  for (const body of ["# Policy", "# Policy\n", "# Правило\r\nЦитата без перевода.\r\n", "---\nstatus: active\n---\n# Policy\n\n"]) {
    const saved = await stampKnowledgeCheck(body, result(body), checkedAt);
    assert.ok(saved.startsWith(body + "\n" + KNOWLEDGE_STAMP_PREFIX));
    assert.equal(stripKnowledgeCheckStamp(saved), body);
    assert.deepEqual(await readKnowledgeCheckStamp(saved), { version: 1, status: "clear", contentHash: hash(body),
      checkedAt, modelRef: "test/model", scope: "retrieved-passages", checkedSources: 2, candidateSources: 7, reportLanguage: "ru" });
    assert.equal(knowledgeEvidenceText(saved).match(/\r\n|\r|\n/gu)?.join(""), saved.match(/\r\n|\r|\n/gu)?.join(""));
    assert.equal(knowledgeEvidenceText(saved).includes(KNOWLEDGE_STAMP_PREFIX), false);
  }
});

test("editing, copying and newline conversion invalidate a saved check", async () => {
  const body = "# Policy\nRequests allow ten attempts.\n", saved = await stampKnowledgeCheck(body, result(body), checkedAt);
  assert.equal(await readKnowledgeCheckStamp(saved.replace("ten", "eleven")), undefined);
  assert.equal(await readKnowledgeCheckStamp("Another document." + saved.slice(body.length)), undefined);
  assert.equal(await readKnowledgeCheckStamp(body.replaceAll("\n", "\r\n") + saved.slice(body.length)), undefined);
  await assert.rejects(stampKnowledgeCheck(body + "Changed", result(body), checkedAt), /does not match/u);
});

test("restamping replaces prior metadata without changing the body hash or accumulating footers", async () => {
  const body = "# Policy\nExact quotation.\n", saved = await stampKnowledgeCheck(body, result(body), checkedAt);
  const later = "2026-10-31T01:02:03.004Z";
  const replaced = await stampKnowledgeCheck(saved, result(body, { modelRef: "other/model", reportLanguage: "en" }), later);
  assert.equal(stripKnowledgeCheckStamp(replaced), body);
  assert.equal(replaced.split(KNOWLEDGE_STAMP_PREFIX).length - 1, 1);
  assert.equal((await readKnowledgeCheckStamp(replaced))?.contentHash, hash(body));
  assert.equal((await readKnowledgeCheckStamp(replaced))?.checkedAt, later);
  const duplicate = saved + saved.slice(body.length);
  assert.equal(await readKnowledgeCheckStamp(duplicate), undefined);
  assert.equal(stripKnowledgeCheckStamp(duplicate), body);
  assert.ok(await readKnowledgeCheckStamp(await stampKnowledgeCheck(duplicate, result(body), checkedAt)));
  const malformed = body + "\n" + KNOWLEDGE_STAMP_PREFIX + "broken JSON -->\n";
  assert.equal(await readKnowledgeCheckStamp(malformed), undefined);
  assert.equal(stripKnowledgeCheckStamp(await stampKnowledgeCheck(malformed, result(body), checkedAt)), body);
});

test("documentation examples remain ordinary hashed body content", async () => {
  const body = "# Marker format\n```html\n" + KNOWLEDGE_STAMP_PREFIX + "{example} -->\n```\nThe example above is ordinary documentation.\n";
  const saved = await stampKnowledgeCheck(body, result(body), checkedAt);
  assert.equal(stripKnowledgeCheckStamp(saved), body);
  assert.equal((await readKnowledgeCheckStamp(saved))?.contentHash, hash(body));
  assert.ok(knowledgeEvidenceText(saved).startsWith(body));
});

test("saved metadata cannot terminate its HTML comment or translate document text", async () => {
  const body = "Original English quotation.\nРусская цитата.\n", modelRef = "provider/<model-->name>";
  const saved = await stampKnowledgeCheck(body, result(body, { modelRef }), checkedAt);
  assert.equal(stripKnowledgeCheckStamp(saved), body);
  assert.equal(saved.slice(body.length).split("-->").length - 1, 1);
  assert.match(saved, /\\u003cmodel--\\u003ename\\u003e/u);
  assert.equal((await readKnowledgeCheckStamp(saved))?.modelRef, modelRef);
});

test("only complete, grounded, bounded successful results can be stamped", async () => {
  const body = "# Policy\n";
  for (const changes of [{ status: "incomplete" }, { status: "conflicts" }, { checkedSources: 0 },
    { documentHash: "A".repeat(64) }, { modelRef: "" }, { modelRef: "x".repeat(513) },
    { checkedSources: 4097 }, { reportLanguage: "fr" }] as unknown as Partial<KnowledgeCheckResult>[]) {
    await assert.rejects(stampKnowledgeCheck(body, result(body, changes), checkedAt));
  }
  await assert.rejects(stampKnowledgeCheck(body, result(body), "2026-02-30T12:34:56.789Z"));
  const { reportLanguage: _language, coverage: _coverage, ...legacy } = result(body);
  const legacyStamp = await readKnowledgeCheckStamp(await stampKnowledgeCheck(body, legacy, checkedAt));
  assert.equal(legacyStamp?.reportLanguage, "en");
  assert.equal(legacyStamp?.candidateSources, 2);
  const oversized = body + "\n" + KNOWLEDGE_STAMP_PREFIX + "x".repeat(MAX_KNOWLEDGE_STAMP_BYTES) + " -->\n";
  assert.equal(await readKnowledgeCheckStamp(oversized), undefined);
  await assert.rejects(stampKnowledgeCheck(oversized, result(oversized), checkedAt), /metadata limit/u);
});

test("TypeScript and native readers share exact stamp format fixtures", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/knowledge-check-stamps.json", import.meta.url), "utf8")) as {
    name: string; content: string; valid: boolean;
  }[];
  for (const fixture of fixtures) {
    assert.equal(Boolean(await readKnowledgeCheckStamp(fixture.content)), fixture.valid, fixture.name);
  }
});
