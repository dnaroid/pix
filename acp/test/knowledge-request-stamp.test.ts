import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseKnowledgeCheckRequest } from "../src/knowledge/request.js";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS } from "../src/knowledge/contract.js";
import { KNOWLEDGE_REPORT_PREFIX, KNOWLEDGE_STAMP_PREFIX, MAX_KNOWLEDGE_REPORT_BYTES, MAX_KNOWLEDGE_STAMP_BYTES,
  recordKnowledgeCheck, stampKnowledgeCheck } from "../src/knowledge/stamp.js";

test("request limits exclude bounded saved metadata but preserve exact raw content and baseline", async () => {
  const body = "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS);
  const saved = await stampKnowledgeCheck(body, { status: "clear", path: "wiki/page.md",
    documentHash: createHash("sha256").update(body).digest("hex"), modelRef: "test/model", checkedSources: 1,
    conflicts: [], notices: [] }, "2026-10-30T12:34:56.789Z");
  const request = { cwd: "/project", path: "wiki/page.md", content: saved, expectedContent: saved };
  assert.deepEqual(parseKnowledgeCheckRequest(request), request);
  assert.throws(() => parseKnowledgeCheckRequest({ ...request, content: "x" + saved }));
  assert.throws(() => parseKnowledgeCheckRequest({ ...request,
    content: body + "\n" + KNOWLEDGE_STAMP_PREFIX + "x".repeat(MAX_KNOWLEDGE_STAMP_BYTES) + " -->\n" }));
  assert.throws(() => parseKnowledgeCheckRequest({ ...request,
    content: body + ("\n" + KNOWLEDGE_STAMP_PREFIX + "broken -->\n").repeat(200) }));
});

test("request body limits exclude the bounded report prefix while preserving the raw save baseline", async () => {
  const body = "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS);
  const saved = await recordKnowledgeCheck(body, { status: "incomplete", path: "wiki/page.md",
    documentHash: createHash("sha256").update(body).digest("hex"), modelRef: "test/model", checkedSources: 1,
    conflicts: [], uncertainties: [], reviewedSources: [], notices: ["x".repeat(20_000)] }, "2026-10-30T12:34:56.789Z");
  assert.ok(saved.length > MAX_KNOWLEDGE_DOCUMENT_CHARS + MAX_KNOWLEDGE_STAMP_BYTES);
  const request = { cwd: "/project", path: "wiki/page.md", content: saved, expectedContent: saved };
  assert.deepEqual(parseKnowledgeCheckRequest(request), request);
  assert.throws(() => parseKnowledgeCheckRequest({ ...request, content: saved + "x" }));
  const oversized = KNOWLEDGE_REPORT_PREFIX + "x".repeat(MAX_KNOWLEDGE_REPORT_BYTES) + " -->\n" + body;
  assert.throws(() => parseKnowledgeCheckRequest({ ...request, content: oversized }));
  const repeated = (KNOWLEDGE_REPORT_PREFIX + "malformed -->\n").repeat(12_000) + body;
  assert.throws(() => parseKnowledgeCheckRequest({ ...request, content: repeated }));
});
