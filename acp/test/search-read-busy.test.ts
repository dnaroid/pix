import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, READ_BUSY_BUDGET_MS } from "../src/search/source-work.js";

async function locked(t: { after(fn: () => Promise<unknown>): void }) {
  const base = fileURLToPath(new URL("../../.pi/artifacts/search-read-busy-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sessions.sqlite");
  // Rollback-journal mode: an EXCLUSIVE writer deterministically blocks every reader.
  const peer = new DatabaseSync(file);
  peer.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1); BEGIN EXCLUSIVE; INSERT INTO t VALUES(2)");
  t.after(async () => { try { peer.exec("ROLLBACK"); } catch { /* released */ } peer.close(); });
  return { file, peer };
}

test("read-only open waits asynchronously for a transient peer lock, then reads committed data", async t => {
  const { file, peer } = await locked(t);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    const opening = openDatabase(file, { readOnly: true });
    await delay(60);
    peer.exec("ROLLBACK");
    const db = await opening;
    try { assert.equal((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 1); }
    finally { db.close(); }
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 5, `event loop kept running while waiting (${ticks} ticks)`);
});

test("read-only open gives up after the bounded budget with a busy error", async t => {
  const { file } = await locked(t);
  const started = Date.now();
  await assert.rejects(openDatabase(file, { readOnly: true }), /locked|busy/i);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= READ_BUSY_BUDGET_MS - 20 && elapsed < READ_BUSY_BUDGET_MS + 500, `bounded wait (${elapsed}ms)`);
});

test("read-only open honours cancellation while waiting", async t => {
  const { file } = await locked(t);
  const controller = new AbortController();
  const opening = openDatabase(file, { readOnly: true, signal: controller.signal });
  await delay(30);
  controller.abort();
  await assert.rejects(opening, { name: "AbortError" });
});
