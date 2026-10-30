import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKnowledgeChunks, splitKnowledgeDocument } from "../src/knowledge/chunks.js";
import { boundChunkReport } from "../src/knowledge/chunk-report.js";
import { isKnowledgeCheckResult, MAX_KNOWLEDGE_CHUNK_CHARS, MAX_KNOWLEDGE_DOCUMENT_CHARS } from "../src/knowledge/contract.js";
import type { CheckCompletion } from "../src/knowledge/comparison.js";
import { collectKnowledgeEvidence, type KnowledgeSnapshot } from "../src/knowledge/evidence.js";
import { parseKnowledgeCheckRequest } from "../src/knowledge/request.js";
import { KnowledgeCheckService } from "../src/knowledge/service.js";
import { MAX_KNOWLEDGE_REPORT_BYTES, readKnowledgeReport, recordKnowledgeCheck, stampKnowledgeCheck } from "../src/knowledge/stamp.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const path = "wiki/long.md";
const body = "# Rules\r\nRetries are required.\r\n\r\n" + "Neutral background.\r\n".repeat(2700) + "\r\nRetries are forbidden.\r\n";
const request = { cwd: "/project", path, content: body, expectedContent: body };
const clean = JSON.stringify({ conflicts: [], uncertainties: [] });
const signal = () => new AbortController().signal;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshot = (text: string): KnowledgeSnapshot => ({ document: { path, text }, documentHash: hash(text),
  wikiPath: "wiki", evidence: [{ id: "source", path: "wiki/reference.md", text: "Retries are optional.", startLine: 7 }],
  candidatePaths: ["wiki/reference.md"], complete: true, notices: [], current: async () => true,
  coverage: { scope: "retrieved-passages", checkedPassages: 1, candidateSources: 1, excerptedSources: 0, limits: [] } });
type Payload = { draft: { path: string; text: string; context?: string }; sources: { id: string; path: string; text: string; startLine: number }[] };
const payload = (prompt: Parameters<CheckCompletion>[0]) => JSON.parse(prompt.user) as Payload;

async function check(complete: CheckCompletion = async () => clean,
  collect: (text: string, index: number) => KnowledgeSnapshot = text => snapshot(text), owned = signal()) {
  const chunks = splitKnowledgeDocument({ path, text: body });
  let collected = 0;
  return checkKnowledgeChunks({ request, body, chunks, firstSnapshot: collect(chunks[0]!.text, collected++),
    collect: async input => { assert.equal(input.expectedContent, body); return collect(input.content, collected++); },
    complete, signal: owned, reportLanguage: "ru", modelRef: "test/model" });
}

describe("large Wiki document partitioning", () => {
  it("accepts full documents up to128k while keeping each judge draft within48k", () => {
    assert.equal(parseKnowledgeCheckRequest(request).content, body);
    assert.throws(() => parseKnowledgeCheckRequest({ ...request, content: "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS + 1) }));
    for (const text of [body, "x".repeat(48_001), "x".repeat(128_000), "😀".repeat(48_000),
      "x".repeat(47_999) + "😀" + "x".repeat(47_999), "x".repeat(47_999) + "\r\n" + "x".repeat(47_999)]) {
      const chunks = splitKnowledgeDocument({ path, text });
      assert.equal(chunks.map(chunk => chunk.text).join(""), text);
      assert.ok(chunks.length <= 3);
      let prefix = "";
      for (const chunk of chunks) {
        assert.ok(chunk.text.length > 0 && chunk.text.length <= MAX_KNOWLEDGE_CHUNK_CHARS);
        assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text));
        assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text));
        assert.equal(chunk.startLine, 1 + (prefix.match(/\r\n?|\n/gu) ?? []).length);
        assert.ok(!(prefix.endsWith("\r") && chunk.text.startsWith("\n")));
        prefix += chunk.text;
      }
    }
  });
  it("keeps short documents on one unchanged comparison", () => {
    assert.deepEqual(splitKnowledgeDocument({ path, text: "# Short\nRule." }), [{ path, text: "# Short\nRule.", startLine: 1 }]);
  });
  it("prefers paragraph boundaries without dropping blank lines or changing line endings", () => {
    const text = "a".repeat(25_000) + "\r\n\r\n" + "b".repeat(25_000);
    const chunks = splitKnowledgeDocument({ path, text });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.text, text.slice(0, 25_004));
    assert.equal(chunks[1]!.startLine, 3);
  });
});

describe("merged chunk review", () => {
  it("checks every chunk and every cross-chunk pair under the full document hash", async () => {
    const calls: Payload[] = [];
    const result = await check(async prompt => { calls.push(payload(prompt)); return clean; });
    assert.equal(calls.length, 3);
    assert.equal(result.documentHash, hash(body));
    assert.equal(result.status, "clear");
    assert.deepEqual(result.chunkCoverage, { totalChunks: 2, checkedChunks: 2, totalComparisons: 3, checkedComparisons: 3 });
    assert.equal(result.checkedSources, 1);
    assert.equal(result.coverage?.checkedPassages, 1);
    assert.equal(result.reviewedSources?.length, 1);
    assert.ok(calls[2]!.sources[0]!.id.startsWith("draft-part-"));
    assert.equal(calls[2]!.sources[0]!.path, path);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("finds a contradiction across chunk boundaries and maps both quotes to the full original", async () => {
    const result = await check(async prompt => {
      const input = payload(prompt), source = input.sources.find(item => item.id.startsWith("draft-part-"));
      if (!source) return clean;
      return JSON.stringify({ conflicts: [{ sourceId: source.id, draftQuote: "Retries are required.",
        existingQuote: "Retries are forbidden.", explanation: "Для одной области действия повторы одновременно обязательны и запрещены." }], uncertainties: [] });
    });
    assert.equal(result.status, "conflicts");
    assert.equal(result.conflicts[0]!.draft.startLine, 2);
    assert.equal(result.conflicts[0]!.existing.path, path);
    assert.equal(result.conflicts[0]!.existing.startLine, body.slice(0, body.indexOf("Retries are forbidden.")).replace(/\r\n?/gu, "\n").split("\n").length);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("maps internal findings in a later chunk rather than restarting citation lines at1", async () => {
    const secondClaim = "Neutral background.\n\nRetries are forbidden.";
    const result = await check(async prompt => {
      const input = payload(prompt);
      if (input.sources.some(item => item.id.startsWith("draft-part-")) || !input.draft.text.includes("Retries are forbidden.")) return clean;
      return JSON.stringify({ conflicts: [{ sourceId: "source", draftQuote: secondClaim,
        existingQuote: "Retries are optional.", explanation: "Для одной операции обязательность несовместима с разрешённым выбором." }], uncertainties: [] });
    });
    assert.equal(result.status, "conflicts");
    assert.ok(result.conflicts[0]!.draft.startLine > 2000);
    assert.equal(result.conflicts[0]!.existing.startLine, 7);
  });
  it("keeps earlier grounded conflicts when a later comparison fails and never grants green", async () => {
    let calls = 0;
    const result = await check(async () => {
      if (++calls > 1) throw new Error("provider failed");
      return JSON.stringify({ conflicts: [{ sourceId: "source", draftQuote: "Retries are required.", existingQuote: "Retries are optional.",
        explanation: "The same rule both requires retries and makes them optional." }], uncertainties: [] });
    });
    assert.equal(result.status, "conflicts");
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.chunkCoverage?.checkedChunks, 1);
    assert.equal(result.chunkCoverage?.checkedComparisons, 1);
    assert.match(result.notices.join(" "), /Не удалось завершить сравнение/u);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("invalidates all merged findings if any earlier original snapshot goes stale", async () => {
    const result = await check(async () => clean, (text, index) => ({ ...snapshot(text), current: async () => index !== 0 }));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.reviewedSources, []);
    assert.match(result.notices.join(" "), /изменились во время проверки/u);
  });
  it("retains bounded sampled source display without treating display sampling as an unchecked chunk", async () => {
    const result = await check(async () => clean, (text, index) => ({ ...snapshot(text),
      evidence: Array.from({ length: 12 }, (_, item) => ({ id: `source-${item}`, path: `wiki/${index}-${item}.md`,
        text: `Unique passage ${index}-${item}.\n` + "Evidence.\n".repeat(350), startLine: 1 })),
      candidatePaths: Array.from({ length: 12 }, (_, item) => `wiki/${index}-${item}.md`),
      coverage: { scope: "retrieved-passages", checkedPassages: 12, candidateSources: 12, excerptedSources: 12, limits: ["passage-limit"] },
    }));
    assert.equal(result.status, "clear");
    assert.equal(result.checkedSources, 24);
    assert.equal(result.coverage?.checkedPassages, 24);
    assert.equal(result.coverage?.candidateSources, 24);
    assert.equal(result.coverage?.retainedPassages, 12);
    assert.equal(result.reviewedSources?.length, 12);
    assert.match(result.notices.join(" "), /Список источников.*сокращён/u);
    assert.equal(isKnowledgeCheckResult(result), true);
    assert.equal(isKnowledgeCheckResult({ ...result, reviewedSources: result.reviewedSources?.slice(0, 1) }), false);
  });
  it("aborts between chunks before another collector or model call starts", async () => {
    const controller = new AbortController();
    let calls = 0, collects = 0;
    await assert.rejects(check(async () => { calls++; controller.abort(new Error("stop")); return clean; },
      text => { collects++; return snapshot(text); }, controller.signal), /stop/u);
    assert.equal(calls, 1);
    assert.equal(collects, 1);
  });
  it("rejects transport reports claiming clear with missing chunk or pair comparisons", async () => {
    const result = await check();
    for (const chunkCoverage of [{ ...result.chunkCoverage!, checkedChunks: 1 },
      { ...result.chunkCoverage!, checkedComparisons: 2 }, { ...result.chunkCoverage!, totalChunks: 4 },
      { ...result.chunkCoverage!, checkedComparisons: 4 }, { ...result.chunkCoverage!, totalComparisons: 4 }]) {
      assert.equal(isKnowledgeCheckResult({ ...result, chunkCoverage }), false);
    }
  });
});

it("the service accepts a large request and reuses one runtime for its three comparisons", async () => {
  let calls = 0, runtimes = 0, disposed = 0, collects = 0;
  const checker = new KnowledgeCheckService({ loadReportLanguage: async () => "ru",
    loadPreferences: async () => ({ modelRef: "test/model", thinking: "off" }),
    collect: async input => { collects++; assert.ok(input.content.length <= 48_000); return snapshot(input.content); },
    search: async () => { throw new Error("unused"); },
    createRuntime: async () => { runtimes++; return { dispose: () => { disposed++; }, modelRuntime: {
      getModel: () => ({ provider: "test", id: "model", maxTokens: 8192 }),
      completeSimple: async () => { calls++; return { stopReason: "stop", content: [{ type: "text", text: clean }] }; },
    } as unknown as ModelRuntime }; },
  });
  const result = await checker.check(request, signal());
  assert.equal(result.status, "clear");
  assert.equal(result.documentHash, hash(body));
  assert.equal(calls, 3); assert.equal(collects, 2); assert.equal(runtimes, 1); assert.equal(disposed, 1);
});

it("the real collector validates the large raw baseline for every chunk and returns the complete logical hash", async t => {
  const artifactRoot = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
  await mkdir(artifactRoot, { recursive: true });
  const cwd = await realpath(await mkdtemp(join(artifactRoot, "knowledge-chunks-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi")); await mkdir(join(cwd, "wiki"));
  await writeFile(join(cwd, ".pi/workspace.jsonc"), JSON.stringify({ wiki: { path: "wiki" } }));
  const raw = await stampKnowledgeCheck(body, { status: "clear", path, documentHash: hash(body), modelRef: "test/model",
    checkedSources: 1, conflicts: [], notices: [] });
  await writeFile(join(cwd, path), raw);
  await writeFile(join(cwd, "wiki/reference.md"), "# Reference\nRetries are optional.\n");
  let calls = 0, collections = 0;
  const checker = new KnowledgeCheckService({ loadReportLanguage: async () => "ru",
    loadPreferences: async () => ({ modelRef: "test/model", thinking: "off" }),
    collect: async (input, search, owned, language) => {
      collections++; assert.equal(input.expectedContent, raw);
      assert.ok(input.content.length <= MAX_KNOWLEDGE_CHUNK_CHARS);
      return collectKnowledgeEvidence(input, search, owned, language);
    },
    search: async () => ({ hits: [{ kind: "knowledge", path: "wiki/reference.md", startLine: 1, endLine: 2 }], notices: [],
      status: { complete: true, stale: false, semanticEnabled: true, semantic: { enabled: true, complete: true, state: "ready" } } }),
    createRuntime: async () => ({ dispose: () => {}, modelRuntime: {
      getModel: () => ({ provider: "test", id: "model", maxTokens: 8192 }),
      completeSimple: async () => { calls++; return { stopReason: "stop", content: [{ type: "text", text: clean }] }; },
    } as unknown as ModelRuntime }),
  });
  const result = await checker.check({ cwd, path, content: raw, expectedContent: raw }, signal());
  assert.equal(result.status, "clear");
  assert.equal(result.documentHash, hash(body));
  assert.equal(collections, 2); assert.equal(calls, 3);
  assert.equal(isKnowledgeCheckResult(result), true);
});

it("bounds escaped UTF8 aggregate reports while retaining a red conflict and exact whole quotations", async () => {
  const conflicts = Array.from({ length: 20 }, (_, index) => ({
    draft: { path, quote: `<${index}>` + "<".repeat(3990), startLine: index + 1, endLine: index + 1 },
    existing: { path: "wiki/reference.md", quote: `>${index}<` + ">".repeat(3990), startLine: index + 1, endLine: index + 1 },
    explanation: "Пояснение. ".repeat(180),
  }));
  const result = boundChunkReport({ status: "conflicts", path, documentHash: hash(body), modelRef: "test/model", checkedSources: 1,
    conflicts, uncertainties: [], reviewedSources: [{ path: "wiki/reference.md", quote: "<".repeat(48_000), startLine: 1, endLine: 1 }],
    notices: [], coverage: { scope: "retrieved-passages", checkedPassages: 1, candidateSources: 1, excerptedSources: 0, limits: [] } }, "ru");
  assert.equal(result.status, "conflicts");
  assert.ok(result.conflicts.length > 0 && result.conflicts.length < 20);
  assert.deepEqual(result.conflicts[0], conflicts[0]);
  assert.equal(result.coverage?.retainedPassages, 0);
  assert.match(result.notices.join(" "), /ограничения размера/u);
  assert.equal(isKnowledgeCheckResult(result), true);
  const recorded = await recordKnowledgeCheck(body, result);
  assert.ok(Buffer.byteLength(recorded) - Buffer.byteLength(body) <= MAX_KNOWLEDGE_REPORT_BYTES);
  assert.equal((await readKnowledgeReport(recorded))?.result.conflicts.length, result.conflicts.length);
});
