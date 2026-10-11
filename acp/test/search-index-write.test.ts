import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { SearchIndexBusyError, SearchIndexStore } from "../src/search/index-store.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const base = resolve(".pi/artifacts/search-index-write");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "run-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, store: new SearchIndexStore(1), signal: new AbortController().signal };
}

test("extended acquisition waits for a queued writer without rerunning either operation", async t => {
  const { cwd, store, signal } = await fixture(t);
  const started = gate(), release = gate();
  let firstCalls = 0, secondCalls = 0;
  const first = store.write(cwd, signal, async () => { firstCalls++; started.resolve(); await release.promise; },
    undefined, { acquisitionTimeoutMs: 2000 });
  await started.promise;
  const second = store.write(cwd, signal, async () => { secondCalls++; }, undefined, { acquisitionTimeoutMs: 2000 });
  try {
    await delay(40);
    assert.equal(secondCalls, 0);
  } finally { release.resolve(); await Promise.all([first, second]); }
  assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
});

test("extended acquisition is bounded against another connection and never invokes paid work on timeout", async t => {
  const { cwd, store, signal } = await fixture(t);
  await store.write(cwd, signal, async () => {}, undefined, { acquisitionTimeoutMs: 2000 });
  const blocker = new DatabaseSync(store.path(cwd));
  let calls = 0;
  try {
    blocker.exec("BEGIN IMMEDIATE");
    await assert.rejects(store.write(cwd, signal, async () => { calls++; }, undefined,
      { acquisitionTimeoutMs: 40 }), SearchIndexBusyError);
    assert.equal(calls, 0);
    blocker.exec("ROLLBACK");
    await store.write(cwd, signal, async () => { calls++; }, undefined, { acquisitionTimeoutMs: 2000 });
    assert.equal(calls, 1);
  } finally { blocker.close(); }
});

test("cancelled and timed-out queue waiters cannot run later or let a successor overtake the owner", async t => {
  const { cwd, store, signal } = await fixture(t);
  const started = gate(), release = gate();
  const first = store.write(cwd, signal, async () => { started.resolve(); await release.promise; },
    undefined, { acquisitionTimeoutMs: 2000 });
  await started.promise;
  let abandonedCalls = 0, successorCalls = 0;
  const caller = new AbortController();
  const cancelled = store.write(cwd, caller.signal, async () => { abandonedCalls++; }, undefined,
    { acquisitionTimeoutMs: 2000 });
  const reason = new Error("cancel queued indexing");
  caller.abort(reason);
  try {
    await assert.rejects(cancelled, error => error === reason);
    await assert.rejects(store.write(cwd, signal, async () => { abandonedCalls++; }, undefined,
      { acquisitionTimeoutMs: 40 }), SearchIndexBusyError);
    const successor = store.write(cwd, signal, async () => { successorCalls++; }, undefined,
      { acquisitionTimeoutMs: 2000 });
    try { await delay(20); assert.equal(successorCalls, 0); }
    finally { release.resolve(); await Promise.all([first, successor]); }
    assert.equal(abandonedCalls, 0); assert.equal(successorCalls, 1);
  } finally { release.resolve(); await first; }
});

test("cancellation interrupts another-connection acquisition without a busy error or a late write", async t => {
  const { cwd, store, signal } = await fixture(t);
  await store.write(cwd, signal, async () => {}, undefined, { acquisitionTimeoutMs: 2000 });
  const blocker = new DatabaseSync(store.path(cwd));
  const caller = new AbortController();
  let calls = 0;
  try {
    blocker.exec("BEGIN IMMEDIATE");
    const waiting = store.write(cwd, caller.signal, async () => { calls++; }, undefined,
      { acquisitionTimeoutMs: 2000 });
    const rejected = assert.rejects(waiting, error => error instanceof Error && error.name === "AbortError");
    await delay(40); caller.abort(); await rejected;
    blocker.exec("ROLLBACK");
    await store.write(cwd, signal, async () => {}, undefined, { acquisitionTimeoutMs: 2000 });
    assert.equal(calls, 0);
  } finally { caller.abort(); blocker.close(); }
});
