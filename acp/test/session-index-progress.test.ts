import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { sessionIndexProgress } from "../src/search/session-index-progress.js";
import { indexSessionChunks } from "../src/search/session-chunks.js";

test("heartbeat reports provider waits, bounds pending writes and stops before terminal output", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const records: Record<string, unknown>[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const progress = sessionIndexProgress("unused", 4, async (_root, record) => {
    records.push(record);
    if (record.status === "running") await gate;
  });
  await setImmediate();
  progress.state.phase = "provider";
  progress.state.requestsStarted = 1;
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.phase, "waiting_for_lease");
  assert.equal(records[1]?.phase, "provider");
  assert.equal(records[1]?.requestsStarted, 1);
  t.mock.timers.tick(50000);
  await setImmediate();
  assert.equal(records.length, 2);
  const finishing = progress.finish("cancelled");
  t.mock.timers.tick(50000);
  await setImmediate();
  assert.equal(records.length, 2);
  release(); await finishing;
  assert.equal(records.at(-1)?.status, "cancelled");
  assert.equal(new Set(records.map(r => r.runId)).size, 1);
  t.mock.timers.tick(50000);
  await progress.finish("failed");
  await setImmediate();
  assert.equal(records.length, 3);
});

test("diagnostic writer failure cannot fail indexing progress or leave a timer", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const progress = sessionIndexProgress("unused", 0, async () => { calls++; throw Error("disk unavailable"); });
  await setImmediate();
  t.mock.timers.tick(5000); await setImmediate();
  await progress.finish("completed");
  const finalCalls = calls;
  t.mock.timers.tick(50000); await setImmediate();
  assert.equal(calls, finalCalls);
  assert.equal(calls, 3);
});

test("index passes report committed saves, cache reuse, skips, failures and cancellation without content", async t => {
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
  const directory = join(root, ".pi/artifacts");
  const lines = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name, "events.jsonl"), "utf8")))).join("");
  assert.doesNotMatch(lines, /PRIVATEmessage|PRIVATEprovider/);
  const records = lines.trim().split("\n").map(line => JSON.parse(line));
  const finals = records.filter(r => r.event === "session_index_progress" && !["started", "running"].includes(r.status));
  assert.deepEqual(finals.map(r => r.status), ["completed", "completed", "incomplete", "failed", "cancelled"]);
  assert.equal(new Set(finals.map(r => r.runId)).size, 5);
  assert.equal(finals[0].chunksDiscovered, 2);
  assert.equal(finals[0].cachedChunks, 0);
  assert.equal(finals[0].savedVectors, 1); // Repeated text shares one paid vector.
  assert.equal(finals[0].requestsStarted, 1);
  assert.equal(finals[0].requestsCompleted, 1);
  assert.equal(finals[1].cachedChunks, 2);
  assert.equal(finals[1].savedVectors, 0);
  assert.equal(finals[1].requestsStarted, 0);
  assert.equal(finals[2].sessionsTotal, 2);
  assert.equal(finals[2].sessionsChecked, 2);
  assert.equal(finals[2].sessionsSkipped, 1);
  assert.equal(finals[3].requestsStarted, 1);
  assert.equal(finals[3].requestsCompleted, 0);
  assert.equal(finals[3].savedVectors, 0);
  assert.equal(finals[3].phase, "provider");
  assert.equal(finals[4].savedVectors, 0);
});
