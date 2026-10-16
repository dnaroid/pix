import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeDirsWithRetry } from "../../external/pi-tools-suite/test/support/fs-retry.mjs";
import { SessionIdlePolicy, IdleSessionSelection, SESSION_IDLE_MS } from "../src/search/session-idle.js";
import { indexSessionChunks, hasSessionChunkVectors } from "../src/search/session-chunks.js";
import { SessionSearchActivity } from "../src/search/session-activity.js";
import { writeSourcePolicy } from "../src/search/source-policy.js";
import type { SessionMapRecord } from "../src/acp/session-map.js";
const signal = () => new AbortController().signal;
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const base = resolve(".pi/artifacts/session-idle-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  await writeSourcePolicy(root, "sessions", true);
  const policies: SessionIdlePolicy[] = [];
  t.after(async () => { await Promise.all(policies.map(p => p.dispose())); await removeDirsWithRetry([root]); });
  let now = Date.now();
  const candidates = await Promise.all(["a", "b"].map(async id => {
    const candidate = { id, path: join(root, `${id}.jsonl`) };
    await writeFile(candidate.path, [JSON.stringify({ type: "session", id, cwd: root }),
      JSON.stringify({ type: "message", id: "first", parentId: null, message: {
        role: "user", content: [{ type: "text", text: `Public text ${id}` }] } })].join("\n") + "\n");
    await utimes(candidate.path, new Date(now), new Date(now));
    return candidate;
  }));
  const policy = () => {
    const instance = new SessionIdlePolicy(root, () => now);
    policies.push(instance);
    return instance;
  };
  return { root, candidates, policy, advance: (ms: number) => { now += ms; }, now: () => now };
}
test("one-hour boundary, per-session reset, running guard and restart reuse", async t => {
  const f = await fixture(t), p = f.policy(), [a, b] = f.candidates;
  f.advance(SESSION_IDLE_MS - 1);
  assert.equal(await p.eligible(a!, signal()), false);
  f.advance(1);
  assert.equal(await p.eligible(a!, signal()), true);
  await p.observe(a!.id, true);
  assert.equal(await p.eligible(a!, signal()), false);
  assert.equal(await p.eligible(b!, signal()), true);
  f.advance(SESSION_IDLE_MS + 1);
  assert.equal(await p.eligible(a!, signal()), false, "a running local agent outlives a lease interval");
  await p.observe(a!.id, false);
  const restarted = f.policy();
  assert.equal(await restarted.eligible(a!, signal()), false, "settled activity is persisted across owners");
  assert.equal(await restarted.eligible(b!, signal()), true, "restart does not postpone another idle session");
  f.advance(SESSION_IDLE_MS);
  assert.equal(await restarted.eligible(a!, signal()), true);
});
test("leases coordinate hosts and expired owners recover without a restart delay", async t => {
  const f = await fixture(t), owner = f.policy(), other = f.policy(), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS);
  await owner.observe(a.id, true, false);
  assert.equal(await other.eligible(a, signal()), false);
  f.advance(90_001);
  assert.equal(await other.eligible(a, signal()), true, "a crashed owner's expired lease does not block an old transcript");
});
test("queued observations renew leases from commit time, not enqueue time", async t => {
  const f = await fixture(t), owner = f.policy(), other = f.policy(), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS);
  let release!: () => void;
  // Hold the writer queue without a wall-clock sleep or an OS lock timeout.
  Object.assign(owner, { queue: new Promise<void>(resolve => { release = resolve; }) });
  const observation = owner.observe(a.id, true, false);
  f.advance(90_001);
  release(); await observation;
  assert.equal(await other.eligible(a, signal()), false, "the new lease must still be live on arrival");
});
test("failed idle observations retry without resetting their original activity time", async t => {
  const f = await fixture(t), owner = f.policy(), other = f.policy(), a = f.candidates[0]!;
  await owner.observe(a.id, false, false);
  const db = new DatabaseSync(join(f.root, ".pi/search/sessions.sqlite"));
  try {
    db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON pix_session_activity BEGIN SELECT RAISE(ABORT, 'transient write failure'); END");
    f.advance(SESSION_IDLE_MS);
    await assert.rejects(owner.observe(a.id, false), /transient write failure/);
    await assert.rejects(owner.eligible(a, signal()), /transient write failure/);
    db.exec("DROP TRIGGER fail_activity");
    f.advance(SESSION_IDLE_MS / 2);
    await owner.flush();
    assert.equal(await owner.eligible(a, signal()), false);
    assert.equal(await other.eligible(a, signal()), false, "retry persists the missed idle observation");
    f.advance(SESSION_IDLE_MS / 2);
    assert.equal(await other.eligible(a, signal()), true, "retry itself does not restart the hour");
  } finally { db.close(); }
});
test("selection reuses unchanged revisions and file activity restarts its own delay", async t => {
  const f = await fixture(t), p = f.policy(), selection = new IdleSessionSelection(p), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS);
  assert.equal((await selection.select(f.candidates, signal())).length, 2);
  assert.deepEqual(await selection.select(f.candidates, signal()), []);
  await utimes(a.path, new Date(f.now()), new Date(f.now()));
  assert.equal(await p.eligible(a, signal()), false);
  f.advance(SESSION_IDLE_MS);
  assert.deepEqual((await selection.select(f.candidates, signal())).map(c => c.id), [a.id]);
});
test("bulk session inspection preserves live leases, absent files and per-candidate revisions", async t => {
  const f = await fixture(t), owner = f.policy(), reader = f.policy();
  const missing = { id: "missing", path: join(f.root, "missing.jsonl") };
  f.advance(SESSION_IDLE_MS + 1);
  await owner.observe(f.candidates[0]!.id, true, false);
  const candidates = [...f.candidates, missing];
  const bulk = await reader.states(candidates, signal());
  const individual = await Promise.all(candidates.map(candidate => reader.state(candidate, signal())));
  assert.deepEqual(bulk, individual);
  assert.deepEqual(bulk.map(state => state.eligible), [false, true, false]);
  assert.equal(bulk[2]?.revision, "missing");
  await owner.observe(f.candidates[0]!.id, false, false);
  assert.equal((await reader.states(f.candidates, signal()))[0]?.eligible, true);
});
test("selection uses one metadata batch instead of a database connection per session", async t => {
  const f = await fixture(t), p = f.policy(), selection = new IdleSessionSelection(p);
  f.advance(SESSION_IDLE_MS + 1);
  let batches = 0;
  const original = p.states.bind(p);
  p.states = async (...args: Parameters<typeof p.states>) => { batches++; return original(...args); };
  const candidates = Array.from({ length: 100 }, (_, i) => ({ ...f.candidates[i % 2]!, id: `bulk-${i}` }));
  assert.equal((await selection.select(candidates, signal())).length, candidates.length);
  assert.equal(batches, 1);
  assert.deepEqual(await selection.select(candidates, signal()), []);
  assert.equal(batches, 2);
});
test("automatic work defers recent sessions, manual work bypasses idle, cache stays usable", async t => {
  const f = await fixture(t), p = f.policy(); let calls = 0;
  const embedding = { identity: "test", dimension: 2, authorized: async () => true,
    embed: async (texts: string[]) => { calls++; return texts.map(() => [1, 0]); } };
  const eligible = (c: { id: string; path: string }, s: AbortSignal) => p.eligible(c, s);
  const automatic = await indexSessionChunks(f.root, f.candidates, { signal: signal(), embedding, eligible });
  assert.equal(automatic.deferred, 2); assert.equal(calls, 0);
  assert.equal((await indexSessionChunks(f.root, f.candidates, { signal: signal(), embedding, retry: true })).complete, true);
  assert.equal(calls, 2);
  await p.observe(f.candidates[0]!.id, true);
  assert.equal(await hasSessionChunkVectors(f.root, f.candidates, signal(), embedding), true);
});
test("activity during provider work discards vectors and leaves other idle sessions independent", async t => {
  const f = await fixture(t), p = f.policy(), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS);
  const embedding = { identity: "test", dimension: 2, authorized: async () => true,
    embed: async (texts: string[]) => { await p.observe(a.id, true); return texts.map(() => [1, 0]); } };
  const result = await indexSessionChunks(f.root, [a], { signal: signal(), embedding,
    eligible: (c, s) => p.eligible(c, s) });
  assert.equal(result.deferred, 1);
  assert.equal(await hasSessionChunkVectors(f.root, [a], signal(), embedding), false);
  assert.equal(await p.eligible(f.candidates[1]!, signal()), true);
});
test("activity while waiting for a provider slot prevents the queued upload", async t => {
  const f = await fixture(t), p = f.policy(), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS); let calls = 0;
  const embedding = { identity: "test", dimension: 2, authorized: async () => true,
    embed: async (texts: string[], _signal: AbortSignal, beforeSend?: () => Promise<void>) => {
      await p.observe(a.id, true);
      await beforeSend?.();
      calls++; return texts.map(() => [1, 0]);
    } };
  const result = await indexSessionChunks(f.root, [a], { signal: signal(), embedding,
    eligible: (c, s) => p.eligible(c, s) });
  assert.equal(result.deferred, 1);
  assert.equal(calls, 0);
  assert.equal(await hasSessionChunkVectors(f.root, [a], signal(), embedding), false);
});
test("activity written at the final transaction guard cannot deadlock or publish stale vectors", { timeout: 10_000 }, async t => {
  const f = await fixture(t), p = f.policy(), a = f.candidates[0]!;
  f.advance(SESSION_IDLE_MS); let paid = false, checksAfterProvider = 0, observation: Promise<void> | undefined;
  const embedding = { identity: "test", dimension: 2, authorized: async () => true,
    embed: async (texts: string[]) => { paid = true; return texts.map(() => [1, 0]); } };
  const result = await indexSessionChunks(f.root, [a], { signal: signal(), embedding, eligible: async (c, s) => {
    if (paid && ++checksAfterProvider === 2) observation = p.observe(a.id, true);
    return p.eligible(c, s);
  } });
  await observation;
  assert.equal(result.deferred, 1);
  assert.equal(await hasSessionChunkVectors(f.root, [a], signal(), embedding), false);
});
test("ACP activity resolution is ordered across native replacement and idle disposal adds no activity", async () => {
  let native = "first"; const events: string[] = [];
  const tracking = new SessionSearchActivity(async () => ({ piSessionId: native, cwd: "/workspace" }) as SessionMapRecord,
    async (_cwd, id, running) => { events.push(`${id}:${running}`); });
  await tracking.update("acp", true);
  native = "fork";
  await tracking.update("acp", true);
  await tracking.update("acp", false);
  await tracking.dispose();
  await tracking.update("acp", true);
  assert.deepEqual(events, ["first:true", "first:false", "fork:true", "fork:false"]);
});
