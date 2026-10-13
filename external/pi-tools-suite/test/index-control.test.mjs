import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile, stat, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { controlManualIndex, readManualRuns } from "../src/project-search/index-control.mjs";
import { openDatabase } from "../src/project-search/source-work.mjs";
import { runManagedIndex } from "../src/project-search/managed-index-run.mjs";
import { probeSnapshots } from "../src/project-search/snapshot-probe.mjs";

const base = fileURLToPath(new URL("../../../.pi/artifacts/manual-index-tests/", import.meta.url));
async function fixture(t, initialized = true) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  const home = join(root, "home"), previous = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  if (initialized) {
    await mkdir(join(root, ".pi/search"), { recursive: true });
    await writeFile(join(root, ".pi/search/code.sqlite"), "stored derived index");
    await writeFile(join(root, "a.ts"), "export const a=1;");
  }
  const control = request => controlManualIndex(root, request);
  return { root, control, begin: () => control({ action: "begin", source: "code" }),
    finish: (token, extra = {}) => control({ action: "finish", source: "code", token, result: { source: "code", complete: true }, ...extra }) };
}
const signal = () => new AbortController().signal;

test("Settings receipts, source fingerprints and stop are global across project roots", async t => {
  const f = await fixture(t), other = join(f.root, "other"); await mkdir(other);
  const directory = join(process.env.HOME, ".config/pi/search"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.sqlite"), "shared cache");
  const settingsDigest = "a".repeat(64);
  const request = { operation: "snapshot-probe", sources: ["settings"], settingsDigest };
  assert.equal((await probeSnapshots(f.root, request)).observations.settings.source,
    (await probeSnapshots(other, request)).observations.settings.source);
  const { token } = await f.control({ action: "begin", source: "settings", settingsDigest });
  await assert.rejects(controlManualIndex(other, { action: "begin", source: "settings", settingsDigest }), /already running/);
  await f.control({ action: "finish", source: "settings", token, settingsDigest, result: { source: "settings", complete: true } });
  assert.equal((await readManualRuns(other)).settings.receipt.complete, true);
  const next = await controlManualIndex(other, { action: "begin", source: "settings", settingsDigest });
  assert.equal((await f.control({ action: "stop", source: "settings" })).accepted, true);
  assert.equal((await controlManualIndex(other, { action: "heartbeat", source: "settings", token: next.token })).stop, true);
  await assert.rejects(stat(join(other, ".pi")), { code: "ENOENT" });
});

test("reading/stopping missing control storage never initializes it", async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await readManualRuns(f.root), {});
  assert.deepEqual(await f.control({ action: "stop", source: "code" }), { accepted: false });
  await assert.rejects(stat(join(f.root, ".pi")), { code: "ENOENT" });
});

test("shared receipts survive reopening and control heartbeats do not change index identity", async t => {
  const f = await fixture(t);
  const { token } = await f.begin();
  const probe = () => probeSnapshots(f.root, { operation: "snapshot-probe", sources: ["code"] });
  const before = await probe();
  await assert.rejects(f.begin(), /already running/);
  assert.equal((await f.control({ action: "heartbeat", source: "code", token })).accepted, true);
  assert.equal((await probe()).observations.code.index, before.observations.code.index);
  const done = await f.finish(token);
  assert.equal(done.receipt.complete, true);
  assert.equal((await readManualRuns(f.root)).code.receipt.source, (await probe()).observations.code.source);
  assert.equal((await readManualRuns(f.root)).code.state, "complete");
});

test("source changes, cancellation, errors and missing indexes cannot certify full coverage", async t => {
  const f = await fixture(t);
  let started = await f.begin();
  await writeFile(join(f.root, "new.ts"), "changed");
  let done = await f.finish(started.token);
  assert.equal(done.state, "partial"); assert.equal(done.receipt.complete, false);
  started = await f.begin();
  assert.equal((await readManualRuns(f.root)).code.receipt, undefined);
  await f.control({ action: "stop", source: "code" });
  done = await f.finish(started.token);
  assert.equal(done.state, "cancelled"); assert.equal(done.receipt, undefined);
  started = await f.begin();
  done = await f.finish(started.token, { result: undefined });
  assert.equal(done.state, "error"); assert.equal(done.receipt, undefined);
  started = await f.begin();
  await rm(join(f.root, ".pi/search/code.sqlite"));
  done = await f.finish(started.token);
  assert.equal(done.result.complete, false); assert.equal(done.receipt, undefined);
});

test("expired ownership and stale tokens cannot finish or stop a successor", async t => {
  const f = await fixture(t), first = await f.begin();
  const db = await openDatabase(join(f.root, ".pi/search/manual-runs.sqlite"));
  db.exec("UPDATE manual_runs SET expires=1"); db.close();
  assert.equal((await readManualRuns(f.root)).code.state, "interrupted");
  const second = await f.begin();
  assert.equal((await f.finish(first.token)).accepted, false);
  assert.equal((await f.control({ action: "heartbeat", source: "code", token: first.token })).accepted, false);
  assert.equal((await f.control({ action: "stop", source: "code", token: first.token })).accepted, false);
  assert.equal((await f.finish(second.token)).state, "complete");
});

test("separate sources own independent runs and stop stays source-local", async t => {
  const f = await fixture(t), code = await f.begin();
  const tasks = await f.control({ action: "begin", source: "tasks" });
  await f.control({ action: "stop", source: "code" });
  assert.equal((await f.control({ action: "heartbeat", source: "tasks", token: tasks.token })).stop, false);
  assert.equal((await f.finish(code.token)).state, "cancelled");
});

test("redirected and unknown control stores fail closed", async t => {
  const f = await fixture(t), file = join(f.root, ".pi/search/manual-runs.sqlite");
  const other = join(f.root, "other.sqlite");
  const db = await openDatabase(other); db.exec("CREATE TABLE unrelated (id TEXT)"); db.close();
  await symlink(other, file);
  await assert.rejects(f.begin(), /Unsafe/);
  await assert.rejects(readManualRuns(f.root), /Unsafe/);
  await rm(file); await writeFile(file, "bad database");
  await assert.rejects(f.begin());
});

test("managed runner observes remote Stop and waits for transport teardown", async t => {
  const f = await fixture(t);
  let transportStopped = false;
  await assert.rejects(runManagedIndex(f.control, "code", signal(), async owned => {
    await f.control({ action: "stop", source: "code" });
    await new Promise(resolve => owned.addEventListener("abort", resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    transportStopped = true;
    return { source: "code", complete: true };
  }, undefined, 5));
  assert.equal(transportStopped, true);
  assert.equal((await readManualRuns(f.root)).code.state, "cancelled");
});

test("managed runner handles stop at finalization, failure and abort during begin", async () => {
  let finishes = 0;
  const owner = new AbortController();
  const control = async request => {
    if (request.action === "begin") { owner.abort(); return { accepted: true, token: "x" }; }
    if (request.action === "finish") { finishes++; assert.equal(request.cancelled, true); }
    return { accepted: true };
  };
  await assert.rejects(runManagedIndex(control, "code", owner.signal, async () => { throw new Error("Must not start"); }));
  assert.equal(finishes, 1);
  await assert.rejects(runManagedIndex(async request => request.action === "begin" ? { accepted: true, token: "x" }
    : { accepted: true, state: "cancelled", result: { source: "code", complete: false } }, "code", signal(), async () => ({ source: "code", complete: true })));
});

test("caller abort remains observed while finalization is pending", async t => {
  const f = await fixture(t), owner = new AbortController();
  let stopped = false;
  const control = async request => {
    if (request.action === "finish") {
      owner.abort();
      for (let attempt = 0; !stopped && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(stopped, true, "Abort must send a token-scoped Stop before finalization");
    }
    const result = await f.control(request);
    if (request.action === "stop") stopped = true;
    return result;
  };
  await assert.rejects(runManagedIndex(control, "code", owner.signal, async () => ({ source: "code", complete: true })));
  assert.equal((await readManualRuns(f.root)).code.state, "cancelled");
  assert.equal((await readManualRuns(f.root)).code.receipt, undefined);
});

test("a batch Stop between sources fences the not-yet-started tail", async t => {
  const f = await fixture(t);
  let tailStarted = false;
  await assert.rejects(runManagedIndex(f.control, "all", signal(), async (owned, check) => {
    await runManagedIndex(f.control, "code", owned, async () => ({ source: "code", complete: true }));
    assert.equal((await readManualRuns(f.root)).code.state, "complete");
    assert.equal((await f.control({ action: "stop", source: "all" })).accepted, true);
    await check();
    tailStarted = true;
    return { source: "all", complete: true };
  }));
  assert.equal(tailStarted, false);
  assert.equal((await readManualRuns(f.root)).all.state, "cancelled");
  assert.equal((await readManualRuns(f.root)).all.receipt, undefined);
});
