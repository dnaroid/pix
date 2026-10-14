import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIndexFailure, createBackgroundIndexFailureLogger } from "../src/search/search-logging.js";
import { SessionChunkSync } from "../src/search/session-chunk-sync.js";

test("background index failure diagnostics coalesce repeats without leaking errors", async () => {
  let now = 1000;
  const rows: Array<{ root: string; record: Record<string, unknown> }> = [];
  const log = createBackgroundIndexFailureLogger({
    now: () => now,
    write: (root, record) => { rows.push({ root, record }); },
  });
  const busy = Object.assign(new Error("private prompt and credential"), { code: "SQLITE_BUSY" });
  log("/project", busy, "discovery");
  await Promise.resolve();
  assert.deepEqual(rows[0]?.record, {
    event: "session_indexing_stopped", reason: "worker_failed", phase: "discovery",
    errorType: "Error", code: "SQLITE_BUSY",
  });
  for (let i = 0; i < 25; i++) log("/project", busy, "discovery");
  assert.equal(rows.length, 1);
  now += 300_000;
  log("/project", busy, "discovery");
  await Promise.resolve();
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.record.suppressed, 25);
  const unsafe = Object.assign(new Error("private query"), { code: "PRIVATE_TOKEN_123" });
  unsafe.name = "PRIVATE_EXCEPTION_DETAILS";
  log("/project", unsafe, "private_phase");
  await Promise.resolve();
  assert.equal(rows[2]?.record.phase, "unknown");
  assert.equal(rows[2]?.record.errorType, "OtherError");
  assert.equal(rows[2]?.record.code, undefined);
  assert.deepEqual(classifyIndexFailure(unsafe), { errorType: "OtherError" });
  assert.doesNotMatch(JSON.stringify(rows), /private prompt|private query|PRIVATE_TOKEN|PRIVATE_EXCEPTION/);
  log("/project", new DOMException("do not log cancellation", "AbortError"), "indexing");
  await Promise.resolve();
  assert.equal(rows.length, 3);
});

test("backoff stops growing after 15 minutes and successful recovery restores ordinary polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let attempts = 0, fail = true;
  const sync = new SessionChunkSync(async () => {
    attempts++;
    if (fail) throw new Error("temporary error");
  }, controller.signal);
  try {
    sync.changed();
    t.mock.timers.tick(250);
    await sync.worker;
    for (const delay of [120_000, 240_000, 480_000, 900_000, 900_000]) {
      assert.equal(sync.failureBackoffMs, delay);
      t.mock.timers.tick(delay);
      await sync.worker;
    }
    assert.equal(sync.failureBackoffMs, 900_000);
    fail = false;
    t.mock.timers.tick(900_000);
    await sync.worker;
    assert.equal(sync.failureBackoffMs, 0);
    t.mock.timers.tick(30_000);
    await sync.worker;
    assert.equal(attempts, 8);
  } finally {
    controller.abort();
    await sync.dispose();
    t.mock.timers.reset();
  }
});

test("operationally incomplete but non-throwing passes back off; successful retry resets cadence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let calls = 0;
  const sync = new SessionChunkSync(async () => {
    if (++calls === 1) sync.noteIncomplete();
  }, controller.signal);
  try {
    sync.changed();
    t.mock.timers.tick(250);
    await sync.worker;
    assert.equal(sync.failureBackoffMs, 120_000);
    t.mock.timers.tick(30_000);
    assert.equal(calls, 1);
    t.mock.timers.tick(90_000);
    await sync.worker;
    assert.equal(calls, 2);
    assert.equal(sync.failureBackoffMs, 0);
    t.mock.timers.tick(30_000);
    await sync.worker;
    assert.equal(calls, 3);
  } finally {
    controller.abort();
    await sync.dispose();
    t.mock.timers.reset();
  }
});

test("background indexing backs off failed idle retries, then resets after a fresh change", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let attempts = 0;
  let failures = 0;
  const sync = new SessionChunkSync(async () => { attempts++; throw new Error("offline"); },
    controller.signal, () => { failures++; });
  try {
    sync.changed();
    t.mock.timers.tick(250);
    await sync.worker;
    assert.equal(attempts, 1);
    assert.equal(failures, 1);
    assert.equal(sync.failureBackoffMs, 120_000);
    t.mock.timers.tick(30_000);
    assert.equal(attempts, 1, "a failed worker must not retry on the 30-second success cadence");
    t.mock.timers.tick(90_000);
    await sync.worker;
    assert.equal(attempts, 2);
    assert.equal(sync.failureBackoffMs, 240_000);
    sync.changed();
    t.mock.timers.tick(250);
    await sync.worker;
    assert.equal(attempts, 3);
    assert.equal(sync.failureBackoffMs, 120_000, "new source events reset failure backoff");
  } finally {
    controller.abort();
    await sync.dispose();
    t.mock.timers.reset();
  }
});
