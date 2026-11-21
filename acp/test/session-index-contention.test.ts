import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldTask } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { claimWork, openDatabase } from "../src/search/source-work.js";
import { SESSION_PASS_WORK, withSessionPass } from "../src/search/session-pass.js";
import { indexSessionChunks, RECONCILE_BATCH } from "../src/search/session-chunks.js";
import { DesktopSessionChunks } from "../src/search/session-chunk-service.js";
import { SessionIdlePolicy } from "../src/search/session-idle.js";
import { writeSourcePolicy } from "../src/search/source-policy.js";
import type { BackgroundSessionRecord } from "../src/search/background-session-discovery.js";

const signal = () => new AbortController().signal;
async function project(t: { after(fn: () => Promise<unknown>): void }) {
  const base = fileURLToPath(new URL("../../.pi/artifacts/session-index-contention-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSourcePolicy(root, "sessions", true);
  await mkdir(join(root, ".pi/search"), { recursive: true });
  return root;
}
const database = (root: string) => join(root, ".pi/search/sessions.sqlite");
const message = (id: string, parentId: string | null, role: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }], stopReason: "stop" } }) + "\n";

test("background pass lease: a held lease or locked cache defers without running; a free lease runs and is released", async t => {
  const root = await project(t);
  const peer = await openDatabase(database(root)) as unknown as DatabaseSync;
  t.after(async () => { peer.close(); });
  let runs = 0;
  const run = async () => { runs++; return "done"; };

  const held = await claimWork(peer, signal(), { id: SESSION_PASS_WORK });
  assert.deepEqual(await withSessionPass(root, signal(), run), { deferred: "lease_held" });
  await held.release(true);

  peer.exec("BEGIN IMMEDIATE");
  try { assert.deepEqual(await withSessionPass(root, signal(), run), { deferred: "busy" }); }
  finally { peer.exec("ROLLBACK"); }
  assert.equal(runs, 0, "a deferred pass must not touch discovery, titles or the cache");

  assert.deepEqual(await withSessionPass(root, signal(), run), { value: "done" });
  assert.equal(runs, 1);
  const row = peer.prepare("SELECT token,expires FROM pix_search_work WHERE id=?").get(SESSION_PASS_WORK) as { token: string; expires: number };
  assert.equal(row.token, "", "the pass releases its lease");
  // A second host can take the lease immediately afterwards.
  const next = await claimWork(peer, signal(), { id: SESSION_PASS_WORK, waitMs: 0 });
  await next.release(true);
});

test("ACP background pass treats cache contention as a deferral and retries the same revision", async t => {
  const root = await project(t);
  const now = Date.now();
  const path = join(root, "a.jsonl");
  await writeFile(path, JSON.stringify({ type: "session", id: "a", cwd: root }) + "\n" + message("m", null, "user", "needle"));
  await utimes(path, new Date(now - 7_200_000), new Date(now - 7_200_000));
  const records: BackgroundSessionRecord[] = [{ sessionId: "a", piSessionId: "a", piSessionPath: path, cwd: root, updatedAt: "", createdAt: now - 7 * 86_400_000 }];
  const policy = new SessionIdlePolicy(root);
  const failures: unknown[] = [];
  let titles = 0, recoveries = 0, busy = true;
  const chunks = new DesktopSessionChunks(root, { signal: signal(), policy, discover: async () => records,
    discoverBackground: async () => records, embedding: async () => undefined,
    titles: async () => { titles++; if (busy) throw new Error("Search index busy; update deferred"); },
    failed: error => failures.push(error), recovered: () => { recoveries++; } });
  t.after(async () => { await chunks.dispose(); await policy.dispose(); });
  const run = () => (chunks as unknown as { sync: { run(s: AbortSignal): Promise<void> } }).sync.run(signal());

  await run();
  assert.equal(titles, 1);
  assert.deepEqual(failures, [], "busy is not reported as an index failure");
  assert.equal(recoveries, 0, "a deferred pass is not a clean recovery");

  const peer = await openDatabase(database(root)) as unknown as DatabaseSync;
  try {
    const held = await claimWork(peer, signal(), { id: SESSION_PASS_WORK });
    await run();
    assert.equal(titles, 1, "another host's pass lease defers the whole pass");
    await held.release(true);
  } finally { peer.close(); }
  assert.deepEqual(failures, []);

  busy = false;
  await run();
  assert.equal(titles, 2, "the deferred unchanged revision is selected again");
  assert.deepEqual(failures, []);
  assert.equal(recoveries, 1);
});

test("reconcile never holds the write lock across an await and never publishes a partial rebuild", async t => {
  const root = await project(t);
  const candidate = { id: "big", path: join(root, "big.jsonl") };
  const chunkText = (seed: string, count: number) => Array.from({ length: count }, (_, i) => `${seed}${i} `.padEnd(1600, seed)).join("");
  // Several transactions per table: more chunks than one rebuild batch.
  let body = JSON.stringify({ type: "session", id: candidate.id, cwd: root }) + "\n", parent: string | null = null;
  for (let i = 0; i < 64; i++) {
    const id = `m${i}`; body += message(id, parent, i % 2 ? "assistant" : "user", chunkText(String.fromCharCode(97 + (i % 26)), 10)); parent = id;
  }
  await writeFile(candidate.path, body);
  await indexSessionChunks(root, [candidate], { signal: signal() });

  const peer = new DatabaseSync(database(root));
  t.after(async () => { peer.close(); });
  peer.exec("PRAGMA busy_timeout=0");
  const meta = () => peer.prepare("SELECT revision FROM pix_session_indexed_files WHERE session_id=?").get(candidate.id) as { revision: string } | undefined;
  const ranges = () => Number((peer.prepare("SELECT count(*) AS n FROM pix_session_chunk_ranges WHERE session_id=?").get(candidate.id) as { n: number }).n);
  const first = { revision: meta()!.revision, count: ranges() };
  assert.ok(first.count > 2 * RECONCILE_BATCH, `fixture spans several batches (${first.count})`);

  await appendFile(candidate.path, message("tail", parent, "user", chunkText("z", 30)));
  let done = false, writable = 0, locked = 0, unpublished = 0;
  const observed: Array<{ revision?: string; count: number }> = [];
  // Every macrotask turn the indexer yields, a peer host must be able to write
  // immediately and must see either the old, nothing, or the complete new session.
  const probe = (async () => {
    while (!done) {
      await yieldTask();
      try { peer.exec("BEGIN IMMEDIATE"); peer.exec("ROLLBACK"); writable++; }
      catch (error) { if (!/locked|busy/i.test((error as Error).message)) throw error; locked++; }
      const row = meta();
      if (!row) unpublished++;
      observed.push({ revision: row?.revision, count: ranges() });
    }
  })();
  try { await indexSessionChunks(root, [candidate], { signal: signal() }); }
  finally { done = true; await probe; }

  const second = { revision: meta()!.revision, count: ranges() };
  assert.notEqual(second.revision, first.revision);
  assert.equal(locked, 0, `peer writes were blocked ${locked} times while the indexer yielded`);
  assert.ok(writable > 3, "the probe interleaved with the rebuild");
  assert.ok(unpublished > 0, "the rebuild ran in several transactions while unpublished");
  for (const seen of observed) {
    if (seen.revision === first.revision) assert.equal(seen.count, first.count, "old entry is never mixed with new rows");
    else if (seen.revision === second.revision) assert.equal(seen.count, second.count, "new entry is published only when complete");
    else assert.equal(seen.revision, undefined);
  }
});
