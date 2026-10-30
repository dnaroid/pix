import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectKnowledgeEvidence, type KnowledgeCheckInput, type KnowledgeSearch, type KnowledgeSearchHit, type KnowledgeSearchResult } from "../src/knowledge/evidence.js";
import { knowledgeEvidenceText, recordKnowledgeCheck, stampKnowledgeCheck } from "../src/knowledge/stamp.js";

const draft = "# Retry guide\n\nRetry a request at most 5 times.\n";
const policy = "---\nstatus: active\n---\n# Retry policy\nRetry a request at most 3 times.\n";
const artifactRoot = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
const signal = (): AbortSignal => new AbortController().signal;
const hit = (path: string, startLine = 1, endLine = 5): KnowledgeSearchHit => ({ kind: "knowledge", path, startLine, endLine });
const response = (hits: KnowledgeSearchHit[]): KnowledgeSearchResult => ({ hits, notices: [],
  status: { complete: true, stale: false, semanticEnabled: true, semantic: { enabled: true, complete: true, state: "ready" } } });
function assertWholeLines(excerpt: string, original: string): void {
  assert.equal(excerpt, original.slice(0, excerpt.length));
  assert.ok(excerpt.length === original.length || excerpt.endsWith("\n") || original[excerpt.length] === "\n", "excerpt ends inside a line");
}

async function put(root: string, path: string, text: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function project(t: TestContext, wiki = "wiki"): Promise<KnowledgeCheckInput> {
  await mkdir(artifactRoot, { recursive: true });
  const cwd = await realpath(await mkdtemp(join(artifactRoot, "knowledge-evidence-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await put(cwd, ".pi/workspace.jsonc", JSON.stringify({ wiki: { path: wiki } }));
  await put(cwd, `${wiki}/draft.md`, draft);
  await put(cwd, `${wiki}/policy.md`, policy);
  return { cwd, path: `${wiki}/draft.md`, content: draft, expectedContent: draft };
}
const search: KnowledgeSearch = async () => response([hit("wiki/policy.md")]);

async function stamped(text: string, path: string, modelRef = "test/model"): Promise<string> {
  return stampKnowledgeCheck(text, { status: "clear", path,
    documentHash: createHash("sha256").update(text).digest("hex"), modelRef,
    checkedSources: 1, conflicts: [], notices: [] }, "2026-10-30T12:34:56.789Z");
}

test("saved stamps are excluded from queries, draft hashes and model evidence while source line ranges remain valid", async t => {
  const input = await project(t), rawDraft = await stamped(draft, input.path), rawPolicy = await stamped(policy, "wiki/policy.md");
  await put(input.cwd, input.path, rawDraft);
  await put(input.cwd, "wiki/policy.md", rawPolicy);
  const queries: string[] = [];
  const result = await collectKnowledgeEvidence({ ...input, content: rawDraft, expectedContent: rawDraft }, async (_cwd, request) => {
    queries.push(request.query);
    return response([hit("wiki/policy.md", 1, rawPolicy.split("\n").length)]);
  }, signal());
  assert.equal(result.complete, true);
  assert.equal(result.document.text, draft);
  assert.equal(result.documentHash, createHash("sha256").update(draft).digest("hex"));
  assert.ok(queries.length > 0);
  assert.ok(queries.every(query => !query.includes("pix:wiki-check") && !query.includes("contentHash")));
  assert.equal(result.evidence[0]!.startLine, 1);
  assert.equal(result.evidence[0]!.text, knowledgeEvidenceText(rawPolicy));
  assert.equal(result.evidence[0]!.text.includes("pix:wiki-check"), false);
  assert.equal(await result.current(signal()), true);
  await assert.rejects(collectKnowledgeEvidence({ ...input, content: rawDraft, expectedContent: draft }, search, signal()), /changed on disk/u);
});

test("persisted report blocks never become queries, draft content or source evidence", async t => {
  const input = await project(t);
  const reported = async (text: string, path: string) => recordKnowledgeCheck(text, {
    status: "incomplete", path, documentHash: createHash("sha256").update(text).digest("hex"), modelRef: "test/judge",
    checkedSources: 1, conflicts: [], notices: ["IGNORED_REPORT_INSTRUCTION ".repeat(2500)],
  });
  const rawDraft = await reported(draft, input.path), rawPolicy = await reported(policy, "wiki/policy.md");
  assert.ok(rawDraft.length > 52_096);
  await put(input.cwd, input.path, rawDraft);
  await put(input.cwd, "wiki/policy.md", rawPolicy);
  const queries: string[] = [];
  const snapshot = await collectKnowledgeEvidence({ ...input, content: rawDraft, expectedContent: rawDraft }, async (_cwd, request) => {
    queries.push(request.query);
    return response([hit("wiki/policy.md", 1, rawPolicy.split("\n").length)]);
  }, signal());
  assert.equal(snapshot.document.text, draft);
  assert.equal(snapshot.documentHash, createHash("sha256").update(draft).digest("hex"));
  assert.equal(snapshot.complete, true);
  assert.ok(queries.every(query => !query.includes("IGNORED_REPORT_INSTRUCTION") && !query.includes("pix:wiki-report")));
  assert.equal(snapshot.evidence[0]?.text, knowledgeEvidenceText(rawPolicy));
  assert.equal(snapshot.evidence[0]?.text.includes("IGNORED_REPORT_INSTRUCTION"), false);
  assert.equal(snapshot.evidence[0]?.text.split("\n").length, rawPolicy.split("\n").length);
  assert.equal(await snapshot.current(signal()), true);
  await put(input.cwd, "wiki/policy.md", rawPolicy.replace("test/judge", "test/other-judge"));
  assert.equal(await snapshot.current(signal()), false);
});

test("bounded report metadata overhead does not consume the source body byte limit", async t => {
  const input = await project(t), body = "漢".repeat(47_900);
  const raw = await recordKnowledgeCheck(body, { status: "incomplete", path: "wiki/policy.md",
    documentHash: createHash("sha256").update(body).digest("hex"), modelRef: "test/judge",
    checkedSources: 1, conflicts: [], notices: ["r".repeat(383_000)] });
  assert.ok(Buffer.byteLength(raw) > 512 * 1024);
  await put(input.cwd, "wiki/policy.md", raw);
  const snapshot = await collectKnowledgeEvidence(input, async () => response([hit("wiki/policy.md", 2, 2)]), signal());
  assert.equal(snapshot.evidence.length, 1);
  assert.ok(snapshot.evidence[0]!.text.includes(body));
  assert.equal(snapshot.evidence[0]!.text.includes("pix:wiki-report"), false);
  assert.equal(snapshot.notices.some(notice => notice.includes("512 KiB")), false);
});

test("metadata-only edits still invalidate raw target and source snapshots", async t => {
  for (const changed of ["wiki/draft.md", "wiki/policy.md"]) await t.test(changed, async child => {
    const input = await project(child), rawDraft = await stamped(draft, input.path), rawPolicy = await stamped(policy, "wiki/policy.md");
    await put(input.cwd, input.path, rawDraft);
    await put(input.cwd, "wiki/policy.md", rawPolicy);
    const result = await collectKnowledgeEvidence({ ...input, content: rawDraft, expectedContent: rawDraft }, search, signal());
    assert.equal(await result.current(signal()), true);
    await put(input.cwd, changed, await stamped(changed === input.path ? draft : policy, changed, "other/model"));
    assert.equal(await result.current(signal()), false);
  });
});

test("hybrid retrieval is confined to the target Wiki and uses original bytes, excluding self", async t => {
  const input = await project(t, "handbook/product"), requests: Parameters<KnowledgeSearch>[1][] = [];
  const snapshot = await collectKnowledgeEvidence(input, async (cwd, request, passedSignal) => {
    assert.equal(cwd, input.cwd); assert.ok(passedSignal instanceof AbortSignal); requests.push(request);
    return response([hit(input.path), { ...hit("handbook/product/policy.md"), snippet: "invented snippet" } as KnowledgeSearchHit]);
  }, signal());
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.mode, "hybrid"); assert.deepEqual(request.sources, ["knowledge"]);
    assert.equal(request.pathPrefix, "handbook/product"); assert.equal(request.includeContent, false);
  }
  assert.equal(snapshot.evidence.length, 1); assert.equal(snapshot.evidence[0]?.text, policy);
  assert.equal(snapshot.document.text, draft); assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.coverage, { scope: "retrieved-passages", checkedPassages: 1, candidateSources: 1, excerptedSources: 0, limits: [] });
  assert.equal(snapshot.documentHash.length, 64); assert.equal(await snapshot.current(signal()), true);
});
test("in-Wiki non-Markdown search candidates are excluded before validating originals", async t => {
  for (const wiki of ["wiki", "handbook/product"]) await t.test(wiki, async child => {
    const input = await project(child, wiki);
    // Reading this text file would fail UTF-8 validation; the JSON file is absent.
    await put(input.cwd, `${wiki}/notes.txt`, new Uint8Array([0xff, 0, 0xfe]));
    const result = await collectKnowledgeEvidence(input, async () => response([
      hit(`${wiki}/notes.txt`), hit(`${wiki}/missing.json`), hit(`${wiki}/policy.md`),
    ]), signal());
    assert.equal(result.complete, true); assert.deepEqual(result.notices, []);
    assert.deepEqual(result.evidence.map(source => source.path), [`${wiki}/policy.md`]);
    assert.equal(result.evidence[0]?.text, policy);
    assert.equal(result.coverage?.candidateSources, 1);
    assert.equal(await result.current(signal()), true);
    // Excluded formats are not read or retained in the original-content fence.
    await put(input.cwd, `${wiki}/notes.txt`, "Changed outside the Markdown comparison scope.");
    assert.equal(await result.current(signal()), true);
  });
});
test("unsupported-format matches alone cannot establish cross-document consistency", async t => {
  const input = await project(t);
  const result = await collectKnowledgeEvidence(input, async () => response([
    hit("wiki/notes.txt"), hit("wiki/missing.json"),
  ]), signal());
  assert.equal(result.complete, false); assert.deepEqual(result.evidence, []);
  assert.equal(result.coverage?.candidateSources, 0);
  assert.deepEqual(result.notices, ["No related current source passages were available; cross-document consistency could not be established."]);
});
test("format filtering preserves unsafe, private and out-of-Wiki source failures", async t => {
  const cases = [
    ["other/policy.txt", "A search source outside the target Wiki was excluded."],
    ["wiki-archive/policy.md", "A search source outside the target Wiki was excluded."],
    ["wiki/.env/private.txt", "A search source in private or disposable storage was excluded."],
    ["wiki/node_modules/rules.json", "A search source in private or disposable storage was excluded."],
    ["../foreign.txt", "An unsafe search source was excluded."],
  ] as const;
  for (const [path, notice] of cases) await t.test(path, async child => {
    const input = await project(child);
    const result = await collectKnowledgeEvidence(input, async () => response([
      hit(path), hit("wiki/policy.md"),
    ]), signal());
    assert.equal(result.complete, false);
    assert.deepEqual(result.notices, [notice]);
    assert.deepEqual(result.evidence.map(source => source.path), ["wiki/policy.md"]);
    assert.equal(result.coverage?.candidateSources, 1);
  });
});
test("new documents work, but creation during comparison invalidates their baseline", async t => {
  const input = await project(t);
  const snapshot = await collectKnowledgeEvidence({ cwd: input.cwd, path: "wiki/new.md", content: draft }, search, signal());
  assert.equal(await snapshot.current(signal()), true);
  await put(input.cwd, "wiki/new.md", "External change");
  assert.equal(await snapshot.current(signal()), false);
});
test("missing configuration uses the default Wiki and later config creation invalidates it", async t => {
  const input = await project(t);
  await rm(join(input.cwd, ".pi"), { recursive: true });
  const snapshot = await collectKnowledgeEvidence(input, search, signal());
  assert.equal(snapshot.wikiPath, "wiki"); assert.equal(await snapshot.current(signal()), true);
  await put(input.cwd, ".pi/workspace.jsonc", "{}");
  assert.equal(await snapshot.current(signal()), false);
});
test("config, target and related-source changes invalidate a completed snapshot", async t => {
  for (const changed of [".pi/workspace.jsonc", "wiki/draft.md", "wiki/policy.md"]) await t.test(changed, async child => {
    const input = await project(child);
    const snapshot = await collectKnowledgeEvidence(input, search, signal());
    await put(input.cwd, changed, "changed externally");
    assert.equal(await snapshot.current(signal()), false);
  });
});
test("new and unselected Wiki documents invalidate the corpus snapshot", async t => {
  for (const change of ["added", "unselected-edit"]) await t.test(change, async child => {
    const input = await project(child);
    if (change === "unselected-edit") await put(input.cwd, "wiki/unselected.md", "Original unrelated policy.");
    const snapshot = await collectKnowledgeEvidence(input, search, signal());
    assert.equal(await snapshot.current(signal()), true);
    await put(input.cwd, "wiki/unselected.md", "A new conflicting rule, beyond the selected evidence.");
    assert.equal(await snapshot.current(signal()), false);
  });
});

test("a Wiki change during retrieval makes the comparison incomplete", async t => {
  const input = await project(t);
  const result = await collectKnowledgeEvidence(input, async () => {
    await put(input.cwd, "wiki/new-policy.md", "New policy while retrieving evidence.");
    return response([hit("wiki/policy.md")]);
  }, signal());
  assert.equal(result.complete, false); assert.equal(await result.current(signal()), false);
  assert.ok(result.notices.some(notice => notice.includes("changed or could not be verified")));
});

test("stale expected content and invalid config fail before searching", async t => {
  const input = await project(t); let calls = 0;
  const never: KnowledgeSearch = async () => { calls++; return response([]); };
  await assert.rejects(collectKnowledgeEvidence({ ...input, expectedContent: "stale" }, never, signal()), /changed on disk/u);
  await put(input.cwd, ".pi/workspace.jsonc", "{broken");
  await assert.rejects(collectKnowledgeEvidence(input, never, signal()), /Invalid/u);
  assert.equal(calls, 0);
});

test("target traversal and paths outside the configured Wiki are rejected", async t => {
  const input = await project(t);
  for (const path of ["../escape.md", "/tmp/escape.md", "other/guide.md", "wiki/../../escape.md", "wiki/.env/secrets.md"]) {
    await assert.rejects(collectKnowledgeEvidence({ ...input, path }, search, signal()));
  }
  await put(input.cwd, ".pi/workspace.jsonc", '{"wiki":{"path":".pi/artifacts/wiki"}}');
  await assert.rejects(collectKnowledgeEvidence(input, search, signal()), /private or disposable/u);
});

test("outside and ancestor symlinks cannot become target or source evidence", async t => {
  const input = await project(t), other = await project(t);
  await symlink(join(other.cwd, "wiki/policy.md"), join(input.cwd, "wiki/linked.md"));
  const snapshot = await collectKnowledgeEvidence(input, async () => response([hit("wiki/linked.md")]), signal());
  assert.equal(snapshot.complete, false); assert.equal(snapshot.evidence.length, 0);
  await symlink(join(other.cwd, "wiki"), join(input.cwd, "wiki/linked-dir"));
  await assert.rejects(collectKnowledgeEvidence({ ...input, path: "wiki/linked-dir/draft.md" }, search, signal()), /symbolic links/u);
  await put(input.cwd, ".pi/workspace.jsonc", '{"wiki":{"path":"wiki/linked-dir"}}');
  await assert.rejects(collectKnowledgeEvidence(input, search, signal()), /symbolic links/u);
});

test("configuration symlinks cannot select or disclose another project's Wiki", async t => {
  const input = await project(t), other = await project(t);
  await rm(join(input.cwd, ".pi/workspace.jsonc"));
  await symlink(join(other.cwd, ".pi/workspace.jsonc"), join(input.cwd, ".pi/workspace.jsonc"));
  let searched = false;
  await assert.rejects(collectKnowledgeEvidence(input, async () => { searched = true; return response([]); }, signal()), /regular file/u);
  assert.equal(searched, false);
});

test("unsafe, missing and binary candidate originals yield incomplete, not trusted cached snippets", async t => {
  const input = await project(t);
  await put(input.cwd, "wiki/binary.md", new Uint8Array([0xff, 0, 0xfe]));
  const snapshot = await collectKnowledgeEvidence(input, async () => response([
    hit("../foreign.md"), hit("other/private.md"), hit("wiki/missing.md"), hit("wiki/binary.md"),
  ]), signal());
  assert.equal(snapshot.complete, false); assert.equal(snapshot.evidence.length, 0);
  assert.ok(snapshot.notices.some(notice => notice.includes("unsafe")));
  assert.ok(snapshot.notices.some(notice => notice.includes("unavailable")));
});

test("source failures explain invalid ranges, file size and encoding without including file text", async t => {
  const input = await project(t), secret = "FILE_CONTENT_MUST_NOT_ENTER_DIAGNOSTICS";
  await put(input.cwd, "wiki/large.md", secret + "x".repeat(512 * 1024));
  await put(input.cwd, "wiki/encoding.md", new Uint8Array([0xc3, 0x28]));
  const result = await collectKnowledgeEvidence(input, async () => response([
    hit("wiki/policy.md", 1, 999), hit("wiki/large.md", 1, 1), hit("wiki/encoding.md", 1, 1),
  ]), signal());
  assert.equal(result.complete, false); assert.equal(result.evidence.length, 0);
  assert.ok(result.notices.some(notice => notice.includes("wiki/policy.md") && notice.includes("line range")));
  assert.ok(result.notices.some(notice => notice.includes("wiki/large.md") && notice.includes("512 KiB")));
  assert.ok(result.notices.some(notice => notice.includes("wiki/encoding.md") && notice.includes("UTF-8")));
  assert.ok(result.notices.every(notice => !notice.includes(secret) && !notice.includes(input.cwd)));
});

test("Russian retrieval diagnostics preserve native notices, source paths and original evidence", async t => {
  const input = await project(t), nativeNotice = "Native search diagnostic: additional metadata unavailable.";
  await put(input.cwd, "wiki/invalid-encoding.md", new Uint8Array([0xc3, 0x28]));
  const result = await collectKnowledgeEvidence(input, async () => ({
    ...response([hit("wiki/policy.md"), hit("wiki/invalid-encoding.md")]), notices: [nativeNotice],
  }), signal(), "ru");
  assert.equal(result.complete, false);
  assert.equal(result.evidence[0]!.text, policy);
  assert.deepEqual(result.notices, [nativeNotice,
    "Не удалось проверить оригинал источника: wiki/invalid-encoding.md. Источник не является корректным текстом UTF-8."]);
  const empty = await collectKnowledgeEvidence(input, async () => response([hit("wiki/notes.txt")]), signal(), "ru");
  assert.equal(empty.complete, false);
  assert.deepEqual(empty.evidence, []);
  assert.deepEqual(empty.notices, ["Нет доступных актуальных фрагментов связанных источников; согласованность между документами не установлена."]);
});

test("failed, stale and lexical-only search results never become a clear coverage claim", async t => {
  const input = await project(t);
  for (const status of [
    { ...response([]).status, complete: false },
    { ...response([]).status, completeForSelection: false },
    { ...response([]).status, completeForSelection: true, stale: true },
    { ...response([]).status, completeForSelection: true, semantic: { enabled: true, complete: false, state: "partial" } },
    { complete: false, stale: true, semanticEnabled: true },
    { complete: true, stale: false, semanticEnabled: false },
    { complete: true, stale: false, semanticEnabled: true },
    { complete: true, stale: false, semanticEnabled: true, semantic: { enabled: false, complete: true, state: "ready" } },
    { complete: true, stale: false, semanticEnabled: true, semantic: { enabled: true, complete: true, state: "unknown" } },
    { complete: true, stale: false, semanticEnabled: true, semantic: { enabled: true, complete: false, state: "partial" } },
  ]) {
    const result = await collectKnowledgeEvidence(input, async () => ({ hits: [hit("wiki/policy.md")], notices: [], status }), signal());
    assert.equal(result.complete, false); assert.equal(result.evidence.length, 1); assert.ok(result.notices.length);
  }
  const failed = await collectKnowledgeEvidence(input, async () => { throw new Error("offline"); }, signal());
  assert.equal(failed.complete, false); assert.equal(failed.evidence.length, 0);
});

test("explicitly identified retrieval caps describe coverage without failing a completed selection", async t => {
  const input = await project(t), cap = "Candidates capped at the configured limit.";
  const result = await collectKnowledgeEvidence(input, async () => ({
    ...response([hit("wiki/policy.md")]), notices: [cap, "An informational notice."], limitNotices: [cap],
    status: { ...response([]).status, complete: false, completeForSelection: true },
  }), signal());
  assert.equal(result.complete, true); assert.deepEqual(result.notices, ["An informational notice."]);
  assert.deepEqual(result.coverage?.limits, ["candidate-limit"]);
});

test("budgeted queries cover later sections instead of only the start of a long document", async t => {
  const input = await project(t), seen: string[] = [];
  const content = Array.from({ length: 20 }, (_, index) => `Section ${index}: distinct policy statement ${index}.`).join("\n\n");
  const result = await collectKnowledgeEvidence({ ...input, content }, async (_root, request) => {
    seen.push(request.query); return response([hit("wiki/policy.md")]);
  }, signal());
  assert.equal(seen.length, 8); assert.match(seen[0]!, /Section 0/u); assert.match(seen.at(-1)!, /Section 19/u);
  assert.equal(result.complete, true); assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.coverage?.limits, ["query-sampling"]); assert.deepEqual(result.notices, []);
  await assert.rejects(collectKnowledgeEvidence({ ...input, content: "x".repeat(48_001) }, search, signal()), /Invalid/u);
});

test("the shared retrieval deadline preserves evidence and stops subsequent queries", async t => {
  const input = await project(t); let clock = 1000, calls = 0;
  t.mock.method(Date, "now", () => clock);
  const result = await collectKnowledgeEvidence(input, async () => {
    calls++; clock += 45_000; return response([hit("wiki/policy.md")]);
  }, signal());
  assert.equal(calls, 1); assert.equal(result.evidence[0]?.text, policy); assert.equal(result.complete, false);
  assert.ok(result.notices.some(notice => notice.includes("retrieval time budget")));
});

test("long sources use a grounded contiguous passage and preserve lifecycle context", async t => {
  const input = await project(t);
  const long = ["---", "status: superseded", "---", ...Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"policy ".repeat(18)}`)].join("\n");
  await put(input.cwd, "wiki/policy.md", long);
  const result = await collectKnowledgeEvidence(input, async () => response([hit("wiki/policy.md", 90, 100)]), signal());
  const evidence = result.evidence[0]!;
  assert.equal(evidence.startLine, 82); assert.ok(evidence.context?.includes("status: superseded"));
  assertWholeLines(evidence.text, long.split("\n").slice(81).join("\n"));
  assertWholeLines(evidence.context!, long);
  assert.ok(evidence.text.includes(long.split("\n").slice(89, 100).join("\n")));
  assert.equal(result.complete, true); assert.equal(result.coverage?.excerptedSources, 1);
  assert.deepEqual(result.coverage?.limits, ["passage-limit"]);
  await put(input.cwd, "wiki/policy.md", long.replace("status: superseded", "status: active"));
  assert.equal(await result.current(signal()), false);
});

test("a long preceding line cannot displace the matched contradiction from evidence", async t => {
  const input = await project(t);
  const claim = "Retry a request at most 3 times.", text = `${"Background ".repeat(800)}\n${claim}\nAdditional explanation.\n`;
  await put(input.cwd, "wiki/policy.md", text);
  const result = await collectKnowledgeEvidence(input, async () => response([hit("wiki/policy.md", 2, 2)]), signal());
  const evidence = result.evidence[0]!;
  assert.equal(evidence.startLine, 2); assert.equal(evidence.text, `${claim}\nAdditional explanation.\n`);
  assert.equal(evidence.context, undefined); assert.equal(result.complete, true);
});

test("whole-line truncation preserves a matched line exactly at its reserved budget", async t => {
  const input = await project(t), header = "# " + "H".repeat(1197), claim = "C".repeat(5999) + ".";
  await put(input.cwd, "wiki/policy.md", `${header}\n${claim}\n${"Optional trailing explanation. ".repeat(400)}\n`);
  const result = await collectKnowledgeEvidence(input, async () => response([hit("wiki/policy.md", 2, 2)]), signal());
  assert.equal(result.complete, true); assert.equal(result.evidence[0]?.startLine, 2);
  assert.equal(result.evidence[0]?.text, claim); assert.equal(result.evidence[0]?.context, `${header}\n`);
  assert.deepEqual(result.coverage?.limits, ["passage-limit"]);
});

test("a matched range larger than the preferred passage budget retains its complete tail", async t => {
  const input = await project(t);
  await put(input.cwd, "wiki/policy.md", `# Policy\n${"A long requirement ".repeat(400)}\nRetry at most 3 times.\n`);
  const result = await collectKnowledgeEvidence(input, async () => response([hit("wiki/policy.md", 2, 3)]), signal());
  assert.equal(result.evidence.length, 1); assert.equal(result.complete, true);
  assert.ok(result.evidence[0]?.text.endsWith("Retry at most 3 times.\n")); assert.deepEqual(result.notices, []);
});

test("twelve long sources share the context budget and retain their complete retrieved claims", async t => {
  const input = await project(t), hits: KnowledgeSearchHit[] = [];
  const originals = new Map<string, string>();
  for (let i = 0; i < 12; i++) {
    const path = `wiki/policy-${i}.md`;
    const lines = Array.from({ length: 100 }, (_, line) => `Source ${i}, line ${line}: ${"term ".repeat(30)}`);
    if (i === 0) lines[20] = lines[20]! + "A long matched clause. ".repeat(320);
    const text = lines.join("\n");
    await put(input.cwd, path, text); originals.set(path, text); hits.push(hit(path, 20, 22));
  }
  const result = await collectKnowledgeEvidence(input, async () => response(hits), signal());
  assert.equal(result.complete, true); assert.equal(result.evidence.length, 12); assert.deepEqual(result.notices, []);
  assert.equal(result.coverage?.checkedPassages, 12); assert.equal(result.coverage?.candidateSources, 12);
  assert.equal(result.coverage?.excerptedSources, 12);
  assert.deepEqual(new Set(result.coverage?.limits), new Set(["candidate-limit", "context-limit", "passage-limit"]));
  for (const source of result.evidence) {
    const lines = originals.get(source.path)!.split("\n");
    assert.ok(source.text.includes(lines.slice(19, 22).join("\n")));
    assertWholeLines(source.text, lines.slice(source.startLine - 1).join("\n"));
    if (source.context) assertWholeLines(source.context, originals.get(source.path)!);
  }
  assert.ok(result.evidence.reduce((sum, source) => sum + source.text.length + (source.context?.length ?? 0), 0) <= 48_000);
});

test("the source cap is coverage metadata and retains twelve of thirteen retrieved candidates", async t => {
  const input = await project(t), hits: KnowledgeSearchHit[] = []; let calls = 0;
  for (let i = 0; i < 13; i++) { const path = `wiki/source-${i}.md`; await put(input.cwd, path, policy); hits.push(hit(path)); }
  const result = await collectKnowledgeEvidence(input, async () => {
    const offset = calls++ === 0 ? 0 : 1; return response(hits.slice(offset, offset + 12));
  }, signal());
  assert.equal(result.complete, true); assert.equal(result.evidence.length, 12);
  assert.equal(result.coverage?.candidateSources, 13); assert.ok(result.coverage?.limits.includes("source-limit"));
});

test("matched ranges can use the whole evidence budget but cannot overflow it", async t => {
  const input = await project(t);
  await put(input.cwd, "wiki/large.md", "x".repeat(48_000));
  const exact = await collectKnowledgeEvidence(input, async () => response([hit("wiki/large.md", 1, 1)]), signal());
  assert.equal(exact.complete, true); assert.equal(exact.evidence[0]?.text.length, 48_000);
  await put(input.cwd, "wiki/large.md", "x".repeat(48_001));
  const over = await collectKnowledgeEvidence(input, async () => response([hit("wiki/large.md", 1, 1), hit("wiki/policy.md")]), signal());
  assert.equal(over.complete, true); assert.equal(over.evidence.length, 1); assert.equal(over.evidence[0]?.path, "wiki/policy.md");
  assert.ok(over.coverage?.limits.includes("context-limit")); assert.deepEqual(over.notices, []);
  const none = await collectKnowledgeEvidence(input, async () => response([hit("wiki/large.md", 1, 1)]), signal());
  assert.equal(none.complete, false); assert.equal(none.evidence.length, 0);
});

test("abort before retrieval and late completion both propagate cancellation", async t => {
  const input = await project(t), early = new AbortController(); early.abort();
  await assert.rejects(collectKnowledgeEvidence(input, search, early.signal), { name: "AbortError" });
  const late = new AbortController();
  await assert.rejects(collectKnowledgeEvidence(input, async () => {
    late.abort(); return response([hit("wiki/policy.md")]);
  }, late.signal), { name: "AbortError" });
  const snapshot = await collectKnowledgeEvidence(input, search, signal());
  await assert.rejects(snapshot.current(early.signal), { name: "AbortError" });
});
