import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimWork, beginWrite, withProviderSlot } from "../src/project-search/source-work.mjs";
import { removeDirsWithRetry } from "./support/fs-retry.mjs";

const signal = () => new AbortController().signal;
const fixtureRoots = [];
// Remove fixtures after every test's own child-process/worker after hooks have
// completed; Windows cannot remove an SQLite directory while those remain alive.
after(() => removeDirsWithRetry(fixtureRoots));
async function fixture() {
  const base = fileURLToPath(new URL("../../../.pi/artifacts/source-index-split/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "protocol-"));
  fixtureRoots.push(root);
  await mkdir(join(root, ".pi/search"), { recursive: true });
  return root;
}
function worker(t, mode, location) {
  const child = fork(fileURLToPath(new URL("./support/source-work-child.mjs", import.meta.url)), [mode, location], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const messages = [], waiters = [];
  child.on("message", message => {
    messages.push(message);
    for (const wake of waiters.splice(0)) wake();
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  return { child, exited, async event(name) {
    for (;;) {
      const error = messages.find(message => message.event === "error");
      if (error) throw new Error(error.message);
      const found = messages.findIndex(message => message.event === name);
      if (found >= 0) return messages.splice(found, 1)[0];
      await new Promise(resolve => waiters.push(resolve));
    }
  } };
}
test("separate processes deduplicate one source without blocking another source", { timeout: 10000 }, async t => {
  const root = await fixture(t), filename = join(root, "tasks.sqlite");
  const first = worker(t, "work", filename); await first.event("acquired");
  const duplicate = worker(t, "work", filename); await duplicate.event("started");
  const other = worker(t, "work", join(root, "settings.sqlite")); await other.event("acquired");
  other.child.send("finish"); await other.event("done");
  first.child.send("finish"); await first.event("done");
  await duplicate.event("cached"); await duplicate.event("done");
  await Promise.all([first.exited, duplicate.exited, other.exited]);
});
test("killed process work is recoverable after deterministic expiry", { timeout: 10000 }, async t => {
  const root = await fixture(t), filename = join(root, "tasks.sqlite");
  const owner = worker(t, "work", filename); await owner.event("acquired");
  owner.child.kill("SIGKILL"); await owner.exited;
  const db = new DatabaseSync(filename); db.exec("UPDATE pix_search_work SET expires=0"); db.close();
  const recovery = worker(t, "work", filename); await recovery.event("acquired");
  recovery.child.send("finish"); await recovery.event("done"); await recovery.exited;
});
test("global provider capacity applies across six independent processes", { timeout: 10000 }, async t => {
  const root = await fixture(t), workers = Array.from({ length: 6 }, () => worker(t, "slot", root));
  await Promise.all(workers.map(worker => worker.event("started")));
  const acquisitions = workers.map(async (worker, index) => { await worker.event("acquired"); return index; });
  const acquired = new Set();
  for (let n = 0; n < 4; n++) acquired.add(await Promise.race(acquisitions.filter((_, index) => !acquired.has(index))));
  const db = new DatabaseSync(join(root, "search-provider-work.sqlite"), { readOnly: true });
  // Other processes may be committing a slot while this observer reads it.
  db.exec("PRAGMA busy_timeout=2000");
  assert.equal(db.prepare("SELECT count(*) AS n FROM provider_slots").get().n, 4);
  for (const index of acquired) workers[index].child.send("finish");
  for (let index = 0; index < workers.length; index++) {
    if (!acquired.has(index)) { await acquisitions[index]; workers[index].child.send("finish"); }
  }
  await Promise.all(workers.map(worker => worker.exited));
  assert.equal(db.prepare("SELECT count(*) AS n FROM provider_slots").get().n, 0); db.close();
});
test("terminated worker slots recover even while their owning process lives", { timeout: 10000 }, async t => {
  const directory = await fixture(t);
  const module = new URL("../src/project-search/source-work.mjs", import.meta.url).href;
  const thread = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    parentPort.on('message', () => {});
    import(workerData.module).then(({withProviderSlot}) => withProviderSlot(new AbortController().signal,
      async () => { parentPort.postMessage('acquired'); await new Promise(() => {}); }, {directory:workerData.directory}));`,
    { eval: true, workerData: { module, directory } });
  t.after(() => thread.terminate());
  await once(thread, "message"); await thread.terminate();
  const db = new DatabaseSync(join(directory, "search-provider-work.sqlite"));
  assert.equal(db.prepare("SELECT pid FROM provider_slots").get().pid, process.pid);
  db.exec("UPDATE provider_slots SET expires=0"); // Deterministic missing-heartbeat deadline.
  let entered = 0, release;
  const gate = new Promise(resolve => release = resolve);
  let ready; const allEntered = new Promise(resolve => ready = resolve);
  const calls = Array.from({ length: 4 }, () => withProviderSlot(signal(), async () => {
    if (++entered === 4) ready(); await gate;
  }, { directory }));
  await allEntered;
  assert.equal(db.prepare("SELECT count(*) AS n FROM provider_slots").get().n, 4);
  release(); await Promise.all(calls); db.close();
});
test("source heartbeat renews ownership without resurrecting an expired token", async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, "work.sqlite"));
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const work = await claimWork(db, signal(), { ttl: 90 });
  for (let n = 0; n < 10; n++) { t.mock.timers.tick(30); work.assert(db); }
  db.exec("UPDATE pix_search_work SET expires=0");
  t.mock.timers.tick(30);
  assert.throws(() => work.assert(db), /expired/);
  await work.release(); db.close();
});
test("cancelled work retains its claim and provider slot until real transport settles", async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, "work.sqlite"));
  const controller = new AbortController(), work = await claimWork(db, controller.signal);
  work.network(db);
  let entered, finish;
  const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => finish = resolve);
  const transport = work.run(() => withProviderSlot(controller.signal, async () => { entered(); await gate; }, { directory: root }));
  await started; controller.abort();
  let released = false;
  const release = work.release(false).then(() => released = true);
  await beginWrite(db, signal()); db.exec("CREATE TABLE writable_during_http(id); COMMIT");
  assert.equal(released, false);
  assert.notEqual(db.prepare("SELECT token FROM pix_search_work").get().token, "");
  finish(); await transport; await release;
  assert.equal(db.prepare("SELECT token FROM pix_search_work").get().token, ""); db.close();
});
test("provider queue rechecks source ownership before sending paid work", async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, "work.sqlite"));
  const work = await claimWork(db, signal());
  db.exec("UPDATE pix_search_work SET expires=0");
  await assert.rejects(work.run(() => withProviderSlot(signal(), () => assert.fail("lost owner must not send"), { directory: root })), /expired/);
  await work.release(); db.close();
});
test("ACP protocol copy matches the standalone suite", async () => {
  for (const name of ["source-work"]) {
    const suite = await readFile(new URL(`../src/project-search/${name}.mjs`, import.meta.url), "utf8");
    const acp = await readFile(new URL(`../../../acp/src/search/${name}.js`, import.meta.url), "utf8");
    assert.equal(acp, suite.replaceAll("./source-work.mjs", "./source-work.js"));
  }
});
test("work claims release SQLite writer while owned and fence expired publication", async t => {
  const root = await fixture(t), filename = join(root, "work.sqlite");
  const a = new DatabaseSync(filename), b = new DatabaseSync(filename);
  t.after(() => { a.close(); b.close(); });
  const work = await claimWork(a, signal());
  await beginWrite(b, signal());
  b.exec("CREATE TABLE independent(value TEXT); COMMIT");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(claimWork(b, controller.signal));
  a.exec("UPDATE pix_search_work SET expires=0");
  const next = await claimWork(b, signal());
  await beginWrite(a, signal());
  assert.throws(() => work.assert(a), /expired/); a.exec("ROLLBACK");
  await work.release(); // Cannot erase a successor.
  next.assert(b);
  await next.release();
});
test("crashed network ownership has bounded retries and explicit recovery", async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, "work.sqlite"));
  t.after(() => db.close());
  for (let n = 0; n < 2; n++) {
    const work = await claimWork(db, signal());
    await beginWrite(db, signal()); work.network(db); db.exec("COMMIT");
    db.exec("UPDATE pix_search_work SET expires=0"); // Deterministic dead-owner clock.
  }
  await assert.rejects(claimWork(db, signal()), /Continue/);
  const retry = await claimWork(db, signal(), { retry: true });
  await retry.release();
});
test("provider semaphore bounds concurrent requests and cancellation does not leak slots", async t => {
  const directory = await fixture(t);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => withProviderSlot(signal(), async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
  }, { directory })));
  assert.equal(peak, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(withProviderSlot(controller.signal, () => assert.fail("aborted"), { directory }));
  const db = new DatabaseSync(join(directory, "search-provider-work.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM provider_slots").get().n, 0); db.close();
});
