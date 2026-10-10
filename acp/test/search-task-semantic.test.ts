import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopSearchService } from "../src/search/service.js";
import { SearchPreferences, type SearchAuth } from "../src/search/config.js";
import { TASK_SCHEMA } from "../src/registry/task-database.js";
import { parseSemanticTasksRequest, parseSearchConfigRequest } from "../src/search/request.js";
import { SEARCH_EMBEDDING_MODEL } from "../src/search/contract.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/search/embeddings.js";

const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);

async function fixture(t: TestContext) {
  const artifacts = resolve(".pi/artifacts/task-semantic-search/fixtures");
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, "run-"));
  await mkdir(join(cwd, ".pi"));
  const taskDb = join(cwd, ".pi", "tasks.sqlite");
  const db = new DatabaseSync(taskDb);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TASK_SCHEMA}`);
  db.close();
  const preferences = new SearchPreferences(join(cwd, "preferences.jsonc"));
  const calls: string[][] = [];
  const embed: Embedder = async input => { calls.push([...input]); return input.map(vector); };
  const auth: SearchAuth = { available: async () => true, key: async () => "mock-only", save: async () => {} };
  const services: DesktopSearchService[] = [];
  const make = (overrides: Partial<ConstructorParameters<typeof DesktopSearchService>[0]> = {}) => {
    const service = new DesktopSearchService({ preferences, auth, embed, discover: async () => [], ...overrides });
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
  };
  const drop = (id: string) => {
    const db = new DatabaseSync(taskDb);
    try { db.prepare("DELETE FROM tasks WHERE id=?").run(id); }
    finally { db.close(); }
  };
  const rows = (table: string): Array<Record<string, unknown>> => {
    const db = new DatabaseSync(join(cwd, ".pi/search/index.sqlite"), { readOnly: true });
    try { return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>; }
    catch { return []; }
    finally { db.close(); }
  };
  return { cwd, task, put, drop, rows, make, preferences, calls, query: "Magical philosophy", taskDb };
}

test("task-semantic consent is independent, off by default, and no task data is uploaded before an explicit search", async t => {
  const f = await fixture(t);
  f.put(f.task("epic", { epic: true, status: "backlog", modelRef: "private/model:high", links: ["internal/private-plan.md"], sessionId: "secret-session" }));
  const service = f.make();
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.calls, []);
  await service.config({ cwd: f.cwd, enabled: true, sessionTitlesEnabled: true });
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.calls, [], "other semantic consents cannot authorize sending tasks");
  const enabled = await service.config({ cwd: f.cwd, tasksSemanticEnabled: true });
  assert.equal(enabled.tasksSemanticEnabled, true);
  assert.deepEqual(f.calls, [], "checking the box is not an upload request");
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
  await service.config({ cwd: f.cwd, tasksSemanticEnabled: true });
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const count = f.calls.flat().filter(input => input.startsWith("Task title:")).length;
  f.put({ ...initial, status: "done", priority: "high", modelRef: "provider/slow:high", links: ["docs/visible.md"] });
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count);
  const second = f.make();
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count);

  f.put({ ...initial, description: "Revised spell research" });
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, count + 1);
  assert.equal(f.rows("pix_task_vectors").length, 1, "outdated hash and vector are pruned");
  f.drop("work");
  assert.deepEqual((await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.deepEqual(f.rows("pix_task_documents"), []);
  assert.deepEqual(f.rows("pix_task_vectors"), [], "deleting the last task prunes its cached vector");
  f.put(f.task("replacement"));
  await second.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(f.rows("pix_task_documents").map(row => row.task_id), ["replacement"]);
});

test("task-semantic query schema rejects invalid requests and revocation stops all future provider work", async t => {
  const f = await fixture(t);
  for (const request of [{ cwd: f.cwd, query: "", limit: 20 }, { cwd: f.cwd, query: "x", limit: 100 },
    { cwd: "relative", query: "x", limit: 5 }]) assert.throws(() => parseSemanticTasksRequest(request));
  assert.equal(parseSemanticTasksRequest({ cwd: f.cwd, query: " topic ", limit: 1 }).query, "topic");
  assert.equal(parseSearchConfigRequest({ cwd: f.cwd, tasksSemanticEnabled: true }).tasksSemanticEnabled, true);
  f.put(f.task("test"));
  const s = f.make();
  await s.config({ cwd: f.cwd, tasksSemanticEnabled: true });
  await s.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const before = f.calls.length;
  await s.config({ cwd: f.cwd, tasksSemanticEnabled: false });
  assert.deepEqual((await s.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
  assert.equal(f.calls.length, before);
  assert.equal(f.rows("pix_task_vectors").length, 1, "disabling leaves already paid local vectors untouched");
});

test("revoking consent while a noncooperative task embedding is in flight rolls back the vector", async t => {
  const f = await fixture(t);
  f.put(f.task("revoked"));
  await f.preferences.setTasksSemanticEnabled(true);
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
  const inflight = service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  // Attach the rejection handler before revocation: a cooperative AbortSignal
  // may settle while we are still awaiting the preferences write.
  const rejected = assert.rejects(inflight);
  await started;
  await service.config({ cwd: f.cwd, tasksSemanticEnabled: false });
  release();
  await rejected;
  assert.deepEqual(f.rows("pix_task_vectors"), []);
  assert.deepEqual((await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 })).results, []);
});

test("a task edited while its semantic vector is being computed cannot publish that stale vector", async t => {
  const f = await fixture(t);
  f.put(f.task("changing"));
  await f.preferences.setTasksSemanticEnabled(true);
  let begun!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const service = f.make({ embed: async inputs => {
    if (inputs.some(input => input.startsWith("Task title:"))) { begun(); await blocked; }
    return inputs.map(vector);
  } });
  const inflight = service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  await started;
  f.put(f.task("changing", { description: "A completely different version" }));
  release();
  await assert.rejects(inflight, /content changed/i);
  assert.deepEqual(f.rows("pix_task_vectors"), []);
  const retried = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.deepEqual(retried.results.map(hit => hit.taskId), ["changing"]);
  assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("large backlogs index at most 64 task texts per explicit search and report incompleteness", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 70; i++) f.put(f.task(`bulk-${i}`));
  await f.preferences.setTasksSemanticEnabled(true);
  const service = f.make();
  const first = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(first.pendingIndex, true);
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, 64);
  const second = await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  assert.equal(second.pendingIndex, false);
  assert.equal(f.calls.flat().filter(input => input.startsWith("Task title:")).length, 70);
  assert.equal(f.rows("pix_task_documents").length, 70);
  assert.equal(f.rows("pix_task_vectors").length, 70);
});

test("incompatible task embedding metadata fails closed without deleting paid vectors or another index domain", async t => {
  const f = await fixture(t);
  f.put(f.task("original"));
  await f.preferences.setTasksSemanticEnabled(true);
  const service = f.make();
  await service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 });
  const before = f.rows("pix_task_vectors");
  assert.equal(before.length, 1);
  const db = new DatabaseSync(join(f.cwd, ".pi/search/index.sqlite"));
  try { db.prepare("UPDATE pix_task_index_meta SET value='unrelated/model' WHERE key='model'").run(); }
  finally { db.close(); }
  await assert.rejects(service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 }), /identity is incompatible/i);
  assert.deepEqual(f.rows("pix_task_vectors"), before);
  assert.equal(f.rows("pix_task_index_meta").find(row => row.key === "model")?.value, "unrelated/model");
});

test("a malformed task hierarchy is rejected before any provider call", async t => {
  const f = await fixture(t);
  f.put(f.task("orphan", { parentId: "deleted-parent" }));
  await f.preferences.setTasksSemanticEnabled(true);
  const service = f.make();
  await assert.rejects(service.queryTasks({ cwd: f.cwd, query: f.query, limit: 20 }), /missing parent task/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.rows("pix_task_documents"), []);
});
