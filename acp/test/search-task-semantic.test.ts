import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopSearchService } from "../src/search/service.js";
import type { SearchAuth } from "../src/search/config.js";
import { FixtureSearchPreferences as SearchPreferences } from "./central-semantics-fixture.js";
import { TASK_SCHEMA } from "../src/registry/task-database.js";
import { parseSemanticTasksRequest, parseSearchConfigRequest } from "../src/search/request.js";
import { SEARCH_EMBEDDING_MODEL } from "../src/search/contract.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/search/embeddings.js";
import { hashText } from "../src/search/documents.js";

const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);

async function fixture(t: TestContext) {
  const artifacts = resolve(".pi/artifacts/central-semantics-acp/task-fixtures");
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, "run-"));
  await mkdir(join(cwd, ".pi"));
  const taskDb = join(cwd, ".pi", "tasks.sqlite");
  const db = new DatabaseSync(taskDb);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TASK_SCHEMA}`);
  db.close();
  const preferences = new SearchPreferences(join(cwd, "pi-tools-suite.jsonc"));
  const calls: string[][] = [];
  const embed: Embedder = async input => { calls.push([...input]); return input.map(vector); };
  const auth: SearchAuth = { available: async () => true, key: async () => "mock-only", save: async () => {} };
  const services: DesktopSearchService[] = [];
  const listeners = new Set<() => void>();
  const make = (overrides: Partial<ConstructorParameters<typeof DesktopSearchService>[0]> = {}) => {
    const service = new DesktopSearchService({ preferences, auth, embed, discover: async () => [], taskDebounceMs: 0,
      watchTasks: (_cwd, changed) => { listeners.add(changed); return () => { listeners.delete(changed); }; }, ...overrides });
    services.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(services.map(service => service.dispose()));
    await rm(cwd, { recursive: true, force: true });
  });
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Magic ${id}`, description: "Elemental casting notes", type: "feature", status: "todo", priority: "medium",
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", ...extra,
  });
  const put = (record: ReturnType<typeof task>) => {
    const db = new DatabaseSync(taskDb);
    try { db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(record.id, JSON.stringify(record)); }
    finally { db.close(); }
    for (const listener of listeners) listener();
  };
  const drop = (id: string) => {
    const db = new DatabaseSync(taskDb);
    try { db.prepare("DELETE FROM tasks WHERE id=?").run(id); }
    finally { db.close(); }
    for (const listener of listeners) listener();
  };
  const rows = (table: string): Array<Record<string, unknown>> => {
    const db = new DatabaseSync(join(cwd, ".pi/search/index.sqlite"), { readOnly: true });
    try { return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>; }
    catch { return []; }
    finally { db.close(); }
  };
  const idle = async (service: DesktopSearchService) => {
    const end = Date.now() + 5000;
    while ((await service.config({ cwd })).indexing) { assert.ok(Date.now() < end, "index idle timeout"); await delay(5); }
  };
  const sync = async (service: DesktopSearchService) => { await service.sync({ cwd, settings: [] }); await idle(service); };
  return { cwd, task, put, drop, rows, make, preferences, calls, query: "Magical philosophy", taskDb, idle, sync };
}

test("central configuration enables background sync; queries only rank existing task vectors", async t => {
  const f = await fixture(t);
  f.put(f.task("epic", { epic: true, status: "backlog", modelRef: "private/model:high", links: ["internal/private-plan.md"], sessionId: "secret-session" }));
  const service = f.make();
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.calls, []);
  await f.preferences.configure();
  const enabled = await service.config({ cwd: f.cwd });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.sessionTitlesEnabled, true);
  assert.equal(enabled.tasksSemanticEnabled, true);
  assert.deepEqual(f.calls, [], "configuration/status is not an upload request");
  const unindexed = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(unindexed.results, []); assert.equal(unindexed.pendingIndex, true);
  assert.deepEqual(f.calls, [], "queries do not upload missing task documents");
  await f.sync(service);
  const response = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(response.results.map(hit => hit.taskId), ["epic"]);
  assert.equal(response.results[0]?.semantic, true);
  assert.equal(response.pendingIndex, false);
  assert.ok(f.calls.flat().some(text => text.includes("Task title: Magic epic")));
  assert.ok(f.calls.flat().some(text => text === f.query));
  assert.doesNotMatch(f.calls.flat().join(" "), /private\/model|internal\/private-plan|secret-session|backlog|high|epic:true/);
  assert.equal(f.rows("pix_task_documents").length, 1);
  assert.equal(f.rows("pix_task_vectors").length, 1);
  assert.deepEqual(f.rows("documents"), [], "existing settings index namespace stays separate");
  assert.deepEqual(f.rows("pix_task_index_meta").find(row => row.key === "model")?.value, SEARCH_EMBEDDING_MODEL);
});

test("only title/description changes re-embed tasks; status/model/links changes and restarts reuse paid hashes", async t => {
  const f = await fixture(t);
  const initial = f.task("work", { modelRef: "provider/fast:off" });
  f.put(initial);
  const service = f.make();
  await f.preferences.configure(); await service.config({ cwd: f.cwd });
  await f.sync(service);
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const count = f.calls.flat().filter(input => input.startsWith("Task title:")).length;
  f.put({ ...initial, status: "done", priority: "high", modelRef: "provider/slow:high", links: ["docs/visible.md"] });
  await f.idle(service);
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count);
  const second = f.make();
  await f.sync(second);
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count);

  f.put({ ...initial, description: "Revised spell research" });
  await f.idle(second); await f.idle(service);
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count + 1);
  assert.equal(f.rows("pix_task_vectors").length, 1, "outdated hash and vector are pruned");
  f.drop("work");
  await f.idle(second); await f.idle(service);
  assert.deepEqual((await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.rows("pix_task_documents"), []);
  assert.deepEqual(f.rows("pix_task_vectors"), [], "deleting the last task prunes its cached vector");
  f.put(f.task("replacement"));
  await f.idle(second); await f.idle(service);
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(f.rows("pix_task_documents").map(row => row.task_id), ["replacement"]);
});

test("task-semantic query schema rejects invalid requests and revocation stops all future provider work", async t => {
  const f = await fixture(t);
  for (const request of [{ cwd: f.cwd, query: "", limit: 20 }, { cwd: f.cwd, query: "x", limit: 100 },
    { cwd: "relative", query: "x", limit: 5 }]) assert.throws(() => parseSemanticTasksRequest(request));
  assert.equal(parseSemanticTasksRequest({ cwd: f.cwd, query: " topic ", limit: 1 }).query, "topic");
  assert.throws(() => parseSearchConfigRequest({ cwd: f.cwd, tasksSemanticEnabled: true }));
  f.put(f.task("test"));
  const s = f.make();
  await f.preferences.configure(); await s.config({ cwd: f.cwd });
  await f.sync(s);
  await s.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const before = f.calls.length;
  await f.preferences.configure(false); await s.config({ cwd: f.cwd });
  assert.deepEqual((await s.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.equal(f.calls.length, before);
  assert.equal(f.rows("pix_task_vectors").length, 1, "disabling leaves already paid local vectors untouched");
});

test("revoking consent while a noncooperative task embedding is in flight rolls back the vector", async t => {
  const f = await fixture(t);
  f.put(f.task("revoked"));
  await f.preferences.configure();
  let begun!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const service = f.make({ embed: async inputs => {
    if (inputs.some(input => input.startsWith("Task title:"))) {
      begun();
      await blocked; // Ignores AbortSignal, just like a faulty provider.
    }
    return inputs.map(vector);
  } });
  await service.sync({ cwd: f.cwd, settings: [] });
  await started;
  await f.preferences.configure(false); await service.config({ cwd: f.cwd });
  release();
  await f.idle(service);
  assert.deepEqual(f.rows("pix_task_vectors"), []);
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
});

test("a task edited while its semantic vector is being computed cannot publish that stale vector", async t => {
  const f = await fixture(t);
  f.put(f.task("changing"));
  await f.preferences.configure();
  let begun!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const service = f.make({ embed: async inputs => {
    if (inputs.some(input => input.startsWith("Task title:"))) { begun(); await blocked; }
    return inputs.map(vector);
  } });
  await service.sync({ cwd: f.cwd, settings: [] });
  await started;
  f.put(f.task("changing", { description: "A completely different version" }));
  release();
  await f.idle(service);
  assert.equal(f.rows("pix_task_vectors").length, 1, "changed corpus is automatically indexed after fencing stale output");
  assert.deepEqual(f.rows("pix_task_vectors").map(row => row.content_hash),
    [hashText("Task title: Magic changing\nTask description: A completely different version")]);
  const retried = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(retried.results.map(hit => hit.taskId), ["changing"]);
  assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("large backlogs drain fully in batches of at most 16 without a query", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 70; i++) f.put(f.task(`bulk-${i}`));
  await f.preferences.configure();
  const service = f.make();
  await f.sync(service);
  assert.ok(f.calls.every(batch => batch.length <= 16));
  const second = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(second.pendingIndex, false);
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, 70);
  assert.equal(f.rows("pix_task_documents").length, 70);
  assert.equal(f.rows("pix_task_vectors").length, 70);
});

test("incompatible task embedding metadata fails closed without deleting paid vectors or another index domain", async t => {
  const f = await fixture(t);
  f.put(f.task("original"));
  await f.preferences.configure();
  const service = f.make();
  await f.sync(service);
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const before = f.rows("pix_task_vectors");
  assert.equal(before.length, 1);
  const db = new DatabaseSync(join(f.cwd, ".pi/search/index.sqlite"));
  try { db.prepare("UPDATE pix_task_index_meta SET value='unrelated/model' WHERE key='model'").run(); }
  finally { db.close(); }
  f.put(f.task("original", { description: "Changed" })); await f.idle(service);
  assert.match((await service.config({ cwd: f.cwd })).sourceErrors?.tasks ?? "", /unavailable/i);
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.rows("pix_task_vectors"), before);
  assert.equal(f.rows("pix_task_index_meta").find(row => row.key === "model")?.value, "unrelated/model");
});

test("a malformed task hierarchy is rejected before any provider call", async t => {
  const f = await fixture(t);
  f.put(f.task("orphan", { parentId: "deleted-parent" }));
  await f.preferences.configure();
  const service = f.make();
  await f.sync(service);
  await assert.rejects(service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 }), /missing parent task/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.rows("pix_task_documents"), []);
});
