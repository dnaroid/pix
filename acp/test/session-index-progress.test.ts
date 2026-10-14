import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { sessionIndexProgress } from "../src/search/session-index-progress.js";
import { indexSessionChunks } from "../src/search/session-chunks.js";

test("indexer does not send per-pass starts or heartbeats to the central log", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const records: Record<string, unknown>[] = [];
  const progress = sessionIndexProgress("unused", 4, async (_root, record) => { records.push(record); });
  await setImmediate();
  progress.state.phase = "provider";
  progress.state.requestsStarted = 1;
  t.mock.timers.tick(55_000);
  await setImmediate();
  assert.equal(records.length, 0);
  await progress.finish("cancelled");
  assert.equal(records.length, 1);
  assert.equal(records.at(-1)?.status, "cancelled");
  assert.equal(records.at(-1)?.requestsStarted, 1);
  assert.equal(new Set(records.map(r => r.runId)).size, 1);
  t.mock.timers.tick(50_000);
  await progress.finish("failed");
  assert.equal(records.length, 1);
});

test("central-log sink failure cannot fail indexing or leave a timer", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const progress = sessionIndexProgress("unused", 0, async () => { calls++; throw Error("disk unavailable"); });
  await setImmediate();
  t.mock.timers.tick(5000); await setImmediate();
  await progress.finish("completed");
  const finalCalls = calls;
  t.mock.timers.tick(50000); await setImmediate();
  assert.equal(calls, finalCalls);
  assert.equal(calls, 1);
});

test("index passes report committed saves, cache reuse, skips, failures and cancellation without content", async t => {
  const symbol = Symbol.for("pix.diagnostics.sink");
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[symbol];
  const events: Array<{ level: string; event: string; details: Record<string, unknown> }> = [];
  globals[symbol] = (level: string, event: string, details: Record<string, unknown>) => {
    events.push({ level, event, details });
  };
  t.after(() => {
    if (previous === undefined) delete globals[symbol];
    else globals[symbol] = previous;
  });
  const base = resolve(".pi/artifacts/session-progress-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = { id: "native", path: join(root, "session.jsonl") };
  await writeFile(candidate.path, [
    { type: "session", id: candidate.id, cwd: root },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "PRIVATEmessage" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "PRIVATEmessage" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const embedding = { identity: "mock", dimension: 2, authorized: async () => true,
    embed: async (texts: string[]) => texts.map(() => [1, 0]) };
  const signal = () => new AbortController().signal;
  await indexSessionChunks(root, [candidate], { signal: signal(), embedding });
  await indexSessionChunks(root, [candidate], { signal: signal(), embedding });
  await indexSessionChunks(root, [candidate, { id: "missing", path: join(root, "absent.jsonl") }], { signal: signal() });
  await assert.rejects(indexSessionChunks(root, [candidate], { signal: signal(), embedding: {
    ...embedding, identity: "failure", embed: async () => { throw Error("PRIVATEprovider"); },
  } }), /PRIVATEprovider/);
  const abort = new AbortController();
  await assert.rejects(indexSessionChunks(root, [candidate], { signal: abort.signal, embedding: {
    ...embedding, identity: "cancel", embed: async () => { abort.abort(); abort.signal.throwIfAborted(); return []; },
  } }));
  await setImmediate();
  assert.equal(events.some(row => row.event === "search:index-saved" && row.details.savedVectors === 1), true);
  assert.equal(events.some(row => row.event === "search:index-incomplete" && row.details.sessionsSkipped === 1), true);
  assert.equal(events.some(row => row.event === "search:index-failed" && row.details.phase === "provider"), true);
  assert.equal(events.filter(row => row.event === "search:index-failed").length, 1);
  assert.equal(events.some(row => row.event === "search:transcript-skipped"), true);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATEmessage|PRIVATEprovider|absent.jsonl|session.jsonl/);
  assert.equal((await readdir(root)).includes(".pi"), true); // Index data remains in .pi/search.
  const artifacts = join(root, ".pi/artifacts");
  assert.equal((await readdir(artifacts).catch(() => [])).some(name => name.startsWith("search-diagnostics-")), false);
});
