import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { removeDirsWithRetry } from "../../external/pi-tools-suite/test/support/fs-retry.mjs";
import { openDatabase, READ_BUSY_BUDGET_MS } from "../src/search/source-work.js";

async function locked(t: { after(fn: () => Promise<unknown>): void }) {
  const base = fileURLToPath(new URL("../../.pi/artifacts/search-read-busy-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  const file = join(root, "sessions.sqlite");
  let peer: DatabaseSync | undefined;
  t.after(async () => {
    try { peer?.close(); }
    finally { await removeDirsWithRetry([root]); }
  });
  // Rollback-journal mode: an EXCLUSIVE writer deterministically blocks every reader.
  peer = new DatabaseSync(file);
  peer.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1); BEGIN EXCLUSIVE; INSERT INTO t VALUES(2)");
  return { file, peer };
}

function observeReadAttempts(t: TestContext, afterFirstAttempt: () => void) {
  const prepare = DatabaseSync.prototype.prepare;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    // Only the readiness probe in openDatabase prepares a statement before it returns.
    // Leave the real lock held during that probe, then act between retry turns.
    if (++attempts === 1) queueMicrotask(afterFirstAttempt);
    return prepare.call(this, sql);
  });
  return () => attempts;
}

test("read-only open waits asynchronously for a transient peer lock, then reads committed data", async t => {
  const { file, peer } = await locked(t);
  const attempts = observeReadAttempts(t, () => peer.exec("ROLLBACK"));
  const db = await openDatabase(file, { readOnly: true });
  try {
    assert.equal(attempts(), 2, "opening retries after yielding so the peer can unlock");
    assert.equal((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("read-only open gives up after the bounded budget with a busy error", { timeout: 5_000 }, async t => {
  const { file } = await locked(t);
  t.mock.timers.enable({ apis: ["Date"] });
  const attempts = observeReadAttempts(t, () => t.mock.timers.tick(READ_BUSY_BUDGET_MS));
  await assert.rejects(openDatabase(file, { readOnly: true }), /locked|busy/i);
  assert.equal(attempts(), 2, "the deadline stops retries after the next busy result");
});

test("read-only open honours cancellation while waiting", async t => {
  const { file } = await locked(t);
  const controller = new AbortController();
  const attempts = observeReadAttempts(t, () => controller.abort());
  await assert.rejects(openDatabase(file, { readOnly: true, signal: controller.signal }), { name: "AbortError" });
  assert.equal(attempts(), 1, "cancellation stops the pending retry");
});
