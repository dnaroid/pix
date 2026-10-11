import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startSavedTaskEmbeddingSync, registerSavedTaskEmbeddingSync, watchTaskFiles,
  type SavedTaskEmbeddingSync } from "../src/project-search/semantic-task-sync.js";
import { syncSavedTaskVectors } from "../src/project-search/semantic-task-indexer.js";
import { taskSemanticHash, taskSemanticText } from "../src/project-search/semantic-cache.js";
import { searchProject } from "../src/project-search/engine.js";
import type { SemanticSearchOptions } from "../src/project-search/semantic-provider.js";
import type { CommitEmbeddingConfig } from "../src/project-search/semantic-commit-provider.js";
import { removeDirsWithRetry } from "./support/fs-retry.js";

const config: CommitEmbeddingConfig = { provider: "ollama", model: "fake/task-sync", dimension: 4,
  queryPrefix: "", documentPrefix: "", baseUrl: "http://127.0.0.1:19999" };
const roots: string[] = [];
const workers: SavedTaskEmbeddingSync[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.stop())); await removeDirsWithRetry(roots); });

function fixture(count = 1) {
  const scratch = fileURLToPath(new URL("../../../.pi/artifacts/task-sync-tests/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "run-"));
  roots.push(root);
  mkdirSync(join(root, ".git")); mkdirSync(join(root, ".pi"));
  const filename = join(root, ".pi/tasks.sqlite");
  const db = new Database(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL);
    CREATE TABLE task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,hash TEXT NOT NULL REFERENCES attachments(hash),ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,hash));
    PRAGMA user_version=1;`);
  for (let index = 0; index < count; index++) db.query("INSERT INTO tasks(id,payload) VALUES(?,?)").run(`task-${index}`, JSON.stringify({
    id: `task-${index}`, title: `Saved idea ${index}`, description: "Purpose", type: "feature", status: "todo", priority: "medium",
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  }));
  db.close();
  return {
    root,
    edit(sql: string) { const db = new Database(filename); try { db.exec(sql); } finally { db.close(); } },
    rows(sql: string) { const db = new Database(join(root, ".pi/search/index.sqlite"), { readonly: true });
      try { return db.query(sql).all() as Record<string, unknown>[]; } finally { db.close(); } },
  };
}

function harness(root: string, overrides: SemanticSearchOptions = {}) {
  const batches: string[][] = [];
  const timers = new Map<() => void, number>();
  let changed!: () => void;
  let closes = 0;
  const options: SemanticSearchOptions = { loadConfig: async () => config,
    embedTasks: async texts => { batches.push([...texts]); return texts.map(() => [1, 0, 0, 0]); }, ...overrides };
  const services = {
    watch: (_root: string, callback: () => void) => { changed = callback; return () => { closes++; }; },
    schedule: (callback: () => void, ms: number) => { timers.set(callback, ms); return () => { timers.delete(callback); }; },
  };
  const worker = startSavedTaskEmbeddingSync(root, options, services);
  workers.push(worker);
  return { worker, options, services, batches, timers, changed: () => changed(), closes: () => closes,
    async tick() { for (const callback of [...timers.keys()]) { timers.delete(callback); callback(); } await worker.settled(); } };
}

test("bootstrap drains more than 64 saved tasks in bounded batches without a query", async () => {
  const f = fixture(145), h = harness(f.root);
  await h.worker.settled();
  expect(h.batches.map(batch => batch.length)).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 16, 1]);
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_documents")).toEqual([{ n: 145 }]);
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: 145 }]);
  expect(h.timers.size).toBe(0);
});

test("task creation between empty bootstrap snapshot and writer recheck still drains immediately", async () => {
  const f = fixture(0);
  mkdirSync(join(f.root, ".pi/search"));
  const db = new Database(join(f.root, ".pi/search/index.sqlite"));
  db.exec("CREATE TABLE unrelated(value TEXT)"); db.close();
  let checks = 0;
  const h = harness(f.root, { loadConfig: async () => {
    if (++checks === 2) {
      f.edit(`INSERT INTO tasks(id,payload) VALUES('created','{"id":"created","title":"Created during startup","description":"Fresh"}')`);
    }
    return config;
  } });
  await h.worker.settled();
  expect(h.batches).toEqual([["Task title: Created during startup\nTask description: Fresh"]]);
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: 1 }]);
  expect(h.timers.size).toBe(0);
});

test("DB/WAL bursts debounce semantic edits, metadata is a no-op, deletes reconcile and hashes reuse", async () => {
  const f = fixture(), h = harness(f.root);
  await h.worker.settled();
  const original = taskSemanticHash({ id: "task-0", title: "Saved idea 0", description: "Purpose" });
  f.edit("UPDATE tasks SET payload=json_set(payload,'$.status','done','$.sessionId','session','$.filePaths',json('[\"file.ts\"]'))");
  h.changed(); h.changed(); h.changed();
  expect([...h.timers.values()]).toEqual([250]);
  await h.tick(); expect(h.batches).toHaveLength(1);
  f.edit("UPDATE tasks SET payload=json_set(payload,'$.description','Revised purpose')");
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(2);
  f.edit("DELETE FROM tasks"); h.changed(); await h.tick();
  expect(f.rows("SELECT * FROM pix_task_documents")).toEqual([]);
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: 2 }]);
  f.edit(`INSERT INTO tasks(id,payload) VALUES('new-id','{"id":"new-id","title":"Saved idea 0","description":"Purpose"}')`);
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(2);
  expect(f.rows("SELECT * FROM pix_task_documents")).toEqual([{ task_id: "new-id", content_hash: original }]);
  f.edit(`INSERT INTO tasks(id,payload) VALUES('created','{"id":"created","title":"New saved plan","description":"Fresh purpose"}')`);
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(3);
  expect(h.batches[2]).toEqual(["Task title: New saved plan\nTask description: Fresh purpose"]);
  expect(h.batches.every(batch => batch.every(text => text.length <= 2000))).toBe(true);
});

test("task text projection caps at 2000, ignores ids and metadata, and does not upload suffix-only edits", async () => {
  const f = fixture();
  const title = "x".repeat(2100);
  f.edit(`UPDATE tasks SET payload=json_set(payload,'$.title','${title}')`);
  const h = harness(f.root); await h.worker.settled();
  expect(h.batches[0]![0]!.length).toBe(2000);
  expect(taskSemanticText({ id: "ignored", title, description: "secret suffix" })).toBe(h.batches[0]![0]);
  f.edit("UPDATE tasks SET payload=json_set(payload,'$.description','changed outside cap')");
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(1);
});

test("unconfigured provider and missing credential never activate paid work or create the index", async () => {
  const { existsSync } = await import("node:fs");
  for (const options of [{ loadConfig: async () => undefined },
    { loadConfig: async () => ({ ...config, provider: "openrouter" as const }), loadKey: async () => undefined }]) {
    const f = fixture(), h = harness(f.root, options);
    await h.worker.settled(); h.changed(); await h.tick();
    expect(h.batches).toEqual([]); expect(existsSync(join(f.root, ".pi/search/index.sqlite"))).toBe(false);
  }
});

test("live central configuration changes bootstrap catch-up without a task query or mutation", async () => {
  const f = fixture();
  let selected: CommitEmbeddingConfig | undefined;
  const h = harness(f.root, { loadConfig: async () => selected });
  await h.worker.settled(); expect(h.batches).toEqual([]);
  selected = config;
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(1);
  selected = undefined;
  f.edit("UPDATE tasks SET payload=json_set(payload,'$.title','A changed plan')");
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(1);
  selected = config;
  h.changed(); await h.tick(); expect(h.batches).toHaveLength(2);
});

test("revoked configuration during automatic upload rolls back without a retry loop", async () => {
  const f = fixture();
  let selected: CommitEmbeddingConfig | undefined = config;
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const h = harness(f.root, { loadConfig: async () => selected,
    embedTasks: async texts => { entered(); await gate; return texts.map(() => [1, 0, 0, 0]); } });
  await start; selected = undefined; release(); await h.worker.settled();
  expect(f.rows("SELECT name FROM sqlite_master WHERE name='pix_task_vectors'")).toEqual([]);
  expect(h.timers.size).toBe(0);
  await h.worker.stop(); expect(h.timers.size).toBe(0);
});

test("provider errors do not schedule automatic paid retries", async () => {
  const f = fixture();
  let calls = 0;
  const h = harness(f.root, { embedTasks: async () => { calls++; throw new Error("provider unavailable"); } });
  await h.worker.settled();
  expect(calls).toBe(1);
  expect(h.timers.size).toBe(0);
});

test("query task semantics ranks cache only; explicit lexical invokes no provider", async () => {
  const f = fixture();
  let docs = 0, queries = 0;
  const options: SemanticSearchOptions = { loadConfig: async () => config,
    embedTasks: async texts => { docs++; return texts.map(() => [1, 0, 0, 0]); },
    embedQuery: async () => { queries++; return [1, 0, 0, 0]; } };
  const missing = await searchProject(f.root, { query: "unrelated concept", sources: ["tasks"] }, { semantic: options });
  expect(missing.hits).toEqual([]); expect(docs).toBe(0); expect(queries).toBe(0);
  await syncSavedTaskVectors(f.root, undefined, options, new AbortController().signal, config);
  const ranked = await searchProject(f.root, { query: "unrelated concept", sources: ["tasks"] }, { semantic: options });
  expect(ranked.hits.map(hit => hit.taskId)).toEqual(["task-0"]); expect(docs).toBe(1); expect(queries).toBe(1);
  const lexical = await searchProject(f.root, { query: "Saved idea", sources: ["tasks"], indexMode: "lexical" }, { semantic: options });
  expect(lexical.hits.map(hit => hit.taskId)).toEqual(["task-0"]); expect(docs).toBe(1); expect(queries).toBe(1);
});

test("task edited/deleted during upload cannot publish stale hash and catches up current text", async () => {
  for (const outcome of ["edit", "delete"] as const) {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    let calls = 0;
    const h = harness(f.root, { embedTasks: async texts => { if (++calls === 1) { entered(); await gate; } return texts.map(() => [1, 0, 0, 0]); } });
    await start;
    f.edit(outcome === "edit" ? "UPDATE tasks SET payload=json_set(payload,'$.title','New idea')" : "DELETE FROM tasks");
    h.changed(); release(); await h.worker.settled(); await h.tick();
    expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: outcome === "edit" ? 1 : 0 }]);
    expect(calls).toBe(outcome === "edit" ? 2 : 1);
    if (outcome === "edit") expect(f.rows("SELECT content_hash FROM pix_task_documents")).toEqual([
      { content_hash: taskSemanticHash({ id: "task-0", title: "New idea", description: "Purpose" }) },
    ]);
  }
});

test("teardown cancels ignoring provider, releases writer lock, rejects late completion and all owned callbacks", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const h = harness(f.root, { embedTasks: async texts => { entered(); await gate; return texts.map(() => [1, 0, 0, 0]); } });
  await start; h.changed();
  const staleTimer = [...h.timers.keys()][0]!;
  await h.worker.stop(); staleTimer();
  expect(h.closes()).toBe(1); expect(h.timers.size).toBe(0);
  h.changed(); expect(h.timers.size).toBe(0);
  const retry = harness(f.root); await retry.worker.settled();
  expect(retry.batches).toHaveLength(1);
  release(); await Promise.resolve();
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: 1 }]);
  await h.worker.stop(); expect(h.closes()).toBe(1);
});

test("two hosts serialize task batches under shared SQLite transaction ownership", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const first = harness(f.root, { embedTasks: async texts => { entered(); await gate; return texts.map(() => [1, 0, 0, 0]); } });
  await start;
  const second = harness(f.root);
  release(); await Promise.all([first.worker.settled(), second.worker.settled()]);
  expect(second.batches).toEqual([]);
  expect(f.rows("SELECT COUNT(*) AS n FROM pix_task_vectors")).toEqual([{ n: 1 }]);
});

test("registration is inert, session switch owns only current cwd, shutdown cancels pending startup", async () => {
  const first = fixture(), second = fixture();
  const nested = join(second.root, "nested"); mkdirSync(nested);
  const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => Promise<void>>();
  const watched: string[] = [], closed: string[] = [];
  const uploaded: string[] = [];
  registerSavedTaskEmbeddingSync({ on: (event: string, callback: never) => { handlers.set(event, callback); } } as unknown as ExtensionAPI,
    { loadConfig: async () => config, embedTasks: async texts => { uploaded.push(...texts); return texts.map(() => [1, 0, 0, 0]); } },
    { watch: (root: string) => { watched.push(root); return () => { closed.push(root); }; } });
  expect(watched).toEqual([]);
  const start = handlers.get("session_start")!, shutdown = handlers.get("session_shutdown")!;
  await start({}, { cwd: first.root });
  await start({}, { cwd: nested });
  expect(watched).toEqual([first.root, nested]); expect(closed).toEqual([first.root]);
  await shutdown({}, { cwd: nested });
  expect(closed).toEqual([first.root, nested]);
  const pending = start({}, { cwd: first.root });
  await shutdown({}, { cwd: first.root }); await pending;
  expect(watched).toEqual([first.root, nested]);
});

test("production file watcher owns both DB and WAL listeners and disposes only its callbacks", async () => {
  // Assert listener ownership without timing-sensitive sleeps or live provider calls.
  const { watchFile, unwatchFile } = await import("node:fs");
  const f = fixture();
  const files = [join(f.root, ".pi/tasks.sqlite"), join(f.root, ".pi/tasks.sqlite-wal")];
  const other = () => {};
  const existing = files.map(filename => watchFile(filename, { persistent: false }, other));
  const before = existing.map(watcher => watcher.listenerCount("change"));
  let changes = 0;
  const stop = watchTaskFiles(f.root, () => { changes++; });
  existing.forEach((watcher, index) => {
    expect(watcher.listenerCount("change")).toBe(before[index]! + 1);
    watcher.emit("change");
  });
  expect(changes).toBe(2);
  stop(); existing.forEach((watcher, index) => expect(watcher.listenerCount("change")).toBe(before[index]!));
  files.forEach(filename => unwatchFile(filename, other));
});
