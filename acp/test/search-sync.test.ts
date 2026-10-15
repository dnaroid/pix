import { canonicalSearchIndexPath } from "../src/search/canonical-index.js";
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { mkdtempSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopSearchService } from "../src/search/service.js";
import { SearchPreferences } from "../src/search/config.js";
import { parseSearchSyncRequest, parseSearchIndexRequest } from "../src/search/request.js";
import { hashText, settingsDocuments, settingsFingerprint } from "../src/search/documents.js";
import { TASK_SCHEMA } from "../src/registry/task-database.js";
import type { Embedder } from "../src/search/embeddings.js";
import { SEARCH_CACHE_REBUILD_REQUIRED, type SearchSetting } from "../src/search/contract.js";
import { SearchIndexStore } from "../src/search/index-store.js";
import { SettingsTaskIndexer } from "../src/search/settings-task-indexer.js";
import { enableSearchSources, isolateSearchHome } from "./search-sources-fixture.js";
import { writeSourcePolicy } from "../src/search/source-policy.js";

// Separate file-level provider quotas: Node's test runner executes other test
// files in parallel, and those must not exhaust this suite's mock-provider slots.
const savedHome = process.env.HOME;
const providerHome = mkdtempSync(join(tmpdir(), "pix-acp-sync-provider-"));
before(() => { process.env.HOME = providerHome; });
after(async () => {
	if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
	await rm(providerHome, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

const setting = (id: string, description = `Description ${id}`): SearchSetting =>
  ({ id, label: `Label ${id}`, section: "General", description, synonyms: ["second", "first"] });
const task = (id: string, description = `Description ${id}`) => ({ id, title: `Title ${id}`, description,
  type: "feature", status: "todo", priority: "medium", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" });
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < end, "Fixture timed out"); await delay(5); }
}
async function fixture(t: TestContext) {
  const base = resolve(".pi/artifacts/acp-change-indexing/fixtures"); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "run-"));
  const restoreHome = await isolateSearchHome(cwd);
  await enableSearchSources(cwd);
  const configPath = join(cwd, "pi-tools-suite.jsonc");
  const preferences = new SearchPreferences(configPath);
  const configure = async (enabled = true) => writeFile(configPath, JSON.stringify({ search: { embedding: enabled
    ? { embeddingProvider: "ollama", embeddingModel: "fake", vectorSize: 3 } : null } }));
  await configure();
  const calls: string[][] = [];
  const embed: Embedder = async inputs => { calls.push([...inputs]); return inputs.map(() => [1, 0, 0]); };
  const listeners = new Set<() => void>(); let closed = 0;
  const services: DesktopSearchService[] = [];
  const make = (overrides: Partial<ConstructorParameters<typeof DesktopSearchService>[0]> = {}) => {
    const service = new DesktopSearchService({ preferences, embed, discover: async () => [], taskDebounceMs: 1,
      watchTasks: (_cwd, changed) => { listeners.add(changed); return () => { listeners.delete(changed); closed++; }; }, ...overrides });
    services.push(service); return service;
  };
  const notify = () => { for (const changed of listeners) changed(); };
  const tasksPath = join(cwd, ".pi/tasks.sqlite");
  const openTasks = async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const db = new DatabaseSync(tasksPath); db.exec("PRAGMA journal_mode=WAL;");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='tasks'").get()) db.exec(TASK_SCHEMA);
    return db;
  };
  const put = async (record: ReturnType<typeof task>) => {
    const db = await openTasks();
    try { db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(record.id, JSON.stringify(record)); }
    finally { db.close(); } notify();
  };
  const rows = (table: string, workspace = cwd): Array<Record<string, unknown>> => {
    const source = table.startsWith("pix_session_") ? "sessions" : table.startsWith("pix_task_") ? "tasks" : "settings";
    if (!existsSync(canonicalSearchIndexPath(workspace, source))) return [];
    const db = new DatabaseSync(canonicalSearchIndexPath(workspace, source), { readOnly: true });
    try { return db.prepare(`SELECT * FROM ${table}`).all(); } catch { return []; } finally { db.close(); }
  };
  const idle = (service: DesktopSearchService, workspace = cwd) => until(async () => {
    const status = await service.config({ cwd: workspace });
    return !status.indexing && !status.checkingSources?.tasks;
  });
  t.after(async () => { await Promise.all(services.map(service => service.dispose())); await rm(cwd, { recursive: true, force: true }); restoreHome(); });
  return { cwd, configPath, configure, make, calls, listeners, notify, closed: () => closed, tasksPath, openTasks, put, rows, idle };
}

test("missing project policy excludes Tasks/Sessions from background, manual and query paths", async t => {
  const f = await fixture(t); await f.put(task("a"));
  await rm(join(f.cwd, ".pi/search-sources.json"));
  let discovery = 0;
  const s = f.make({ discover: async () => { discovery++; return []; } });
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  await s.config({ cwd: f.cwd, includeSourceStatus: true });
  assert.deepEqual(await s.queryTasks({ cwd: f.cwd, query: "a", limit: 5 }), { results: [], pendingIndex: false });
  assert.deepEqual((await s.query({ cwd: f.cwd, query: "a", types: ["sessions"], settings: [], limit: 5 })).results, []);
  await assert.rejects(s.index({ cwd: f.cwd, source: "tasks" }), /disabled/);
  assert.equal(discovery, 0); assert.equal(f.calls.length, 0); assert.equal(f.listeners.size, 0);
  await writeSourcePolicy(f.cwd, "tasks", true);
  await until(() => f.calls.length === 1); await f.idle(s);
  assert.equal(f.rows("pix_task_vectors").length, 1);
  await writeSourcePolicy(f.cwd, "tasks", false);
  await until(() => f.listeners.size === 0);
  assert.equal(f.rows("pix_task_vectors").length, 1, "disabling retains the purchased cache");
  assert.deepEqual((await s.queryTasks({ cwd: f.cwd, query: "a", limit: 5 })).results, []);
});

test("source toggle aborts a noncooperative background batch without publishing its vectors", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>(); let providerSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => {
    providerSignal = signal; started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]);
  } });
  await s.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  try {
    await writeSourcePolicy(f.cwd, "tasks", false);
    await until(() => Boolean(providerSignal?.aborted));
  } finally { release.resolve(); }
  await f.idle(s);
  assert.deepEqual(f.rows("pix_task_vectors"), []);
});

test("invalid source policy reports a diagnostic while all source paths fail closed", async t => {
  const f = await fixture(t); let discoveries = 0;
  await writeFile(join(f.cwd, ".pi/search-sources.json"), "{");
  const s = f.make({ discover: async () => { discoveries++; return []; } });
  const status = await s.config({ cwd: f.cwd, includeSourceStatus: true });
  assert.match(status.error ?? "", /search-sources\.json/);
  assert.deepEqual((await s.query({ cwd: f.cwd, query: "a", types: ["settings", "sessions"], settings: [], limit: 5 })).results, []);
  assert.equal(discoveries, 0); assert.equal(f.calls.length, 0);
});

test("source-policy ABA rejects in-flight vectors even before the watcher observes either edit", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ watchSourcePolicy: () => () => {}, embed: async inputs => {
    started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]);
  } });
  const operation = s.index({ cwd: f.cwd, source: "tasks" });
  await started.promise;
  try {
    await writeSourcePolicy(f.cwd, "tasks", false);
    await writeSourcePolicy(f.cwd, "tasks", true);
  } finally { release.resolve(); }
  assert.equal((await operation).complete, false);
  assert.deepEqual(f.rows("pix_task_vectors"), []);
});

test("a status read before the policy watcher retains the catalogue and its resync owner", async t => {
  const f = await fixture(t);
  const listeners = new Set<() => void>();
  const s = f.make({ watchSourcePolicy: (_cwd, changed) => {
    listeners.add(changed); return () => { listeners.delete(changed); };
  } });
  await s.sync({ cwd: f.cwd, settings: [setting("retained")] }); await f.idle(s);
  const before = f.calls.length;
  await writeSourcePolicy(f.cwd, "code", false);
  await s.config({ cwd: f.cwd });
  assert.equal(f.calls.length, before, "status reads do not start provider work");
  assert.equal(listeners.size, 1, "the project policy observer survives activation replacement");
  for (const changed of [...listeners]) changed();
  await until(() => f.listeners.size === 1); await f.idle(s);
  assert.deepEqual(f.rows("documents").map(row => row.id), ["settings:retained"]);
  assert.equal(f.calls.length, before, "resync reuses the retained catalogue vectors");
});

test("explicit index parser strictly isolates sources, metadata and configuration", () => {
  const cwd = resolve(".");
  for (const source of ["sessions", "tasks", "commits"] as const) {
    assert.deepEqual(parseSearchIndexRequest({ cwd, source }), { cwd, source });
    assert.throws(() => parseSearchIndexRequest({ cwd, source, settings: [] }));
  }
  assert.deepEqual(parseSearchIndexRequest({ cwd, source: "settings", settings: [setting("a")] }),
    { cwd, source: "settings", settings: [setting("a")] });
  for (const value of [null, [], { cwd, source: "settings" }, { cwd, source: "code" },
    { cwd: ".", source: "tasks" }, { cwd: "/tmp\0", source: "tasks" },
    { cwd, source: "tasks", query: "secret" }, { cwd, source: "tasks", apiKey: "secret" },
    { cwd, source: "settings", settings: [{ ...setting("a"), value: "secret" }] },
    { cwd, source: "settings", settings: [{ ...setting("a"), embeddingModel: "override" }] }]) {
    assert.throws(() => parseSearchIndexRequest(value), (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === -32602);
  }
});

test("explicit settings and task clicks never bootstrap other sources, discovery, watchers or query vectors", async t => {
  const f = await fixture(t); await f.put(task("a"));
  let discoveries = 0;
  const s = f.make({ discover: async () => { discoveries++; return []; } });
  assert.deepEqual(await s.index({ cwd: f.cwd, source: "settings", settings: [setting("a")] }),
    { source: "settings", complete: true, indexed: 1, total: 1 });
  assert.equal(f.rows("pix_task_vectors").length, 0); assert.equal(f.listeners.size, 0); assert.equal(discoveries, 0);
  assert.deepEqual(await s.index({ cwd: f.cwd, source: "tasks" }), { source: "tasks", complete: true, indexed: 1, total: 1 });
  assert.equal(f.calls.flat().length, 2); assert.equal(f.listeners.size, 0); assert.equal(discoveries, 0);
  assert.ok(f.calls[0]![0]!.includes("Label a")); assert.ok(f.calls[1]![0]!.includes("Task title: Title a"));
  await s.index({ cwd: f.cwd, source: "tasks" }); await s.index({ cwd: f.cwd, source: "settings", settings: [setting("a")] });
  assert.equal(f.calls.flat().length, 2, "no query uploads or paid retries of compatible vectors");
});

test("explicit retry recovers only the selected failed automatic source", async t => {
  const f = await fixture(t); await f.put(task("a")); let fail = true;
  const s = f.make({ embed: async inputs => { f.calls.push([...inputs]); if (fail) throw new Error("SECRET"); return inputs.map(() => [1, 0, 0]); } });
  await s.sync({ cwd: f.cwd, settings: [setting("a")] }); await f.idle(s);
  const before = f.calls.length; fail = false;
  assert.equal((await s.index({ cwd: f.cwd, source: "tasks" })).complete, true);
  const tasksOnly = await s.config({ cwd: f.cwd }); assert.match(tasksOnly.sourceErrors?.settings ?? "", /unavailable/);
  assert.equal(tasksOnly.sourceErrors?.tasks, undefined); assert.equal(f.calls.length, before + 1);
  assert.equal(f.rows("vectors").length, 0);
  assert.equal((await s.index({ cwd: f.cwd, source: "settings", settings: [setting("a")] })).complete, true);
  assert.equal(f.calls.length, before + 2); assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
});

for (const source of ["settings", "tasks"] as const) test(`explicit ${source} pass drains beyond 128 and reuses purchased vectors`, async t => {
  const f = await fixture(t), s = f.make();
  const settings = Array.from({ length: 130 }, (_, i) => setting(String(i)));
  if (source === "tasks") {
    const db = await f.openTasks();
    for (let i = 0; i < 130; i++) db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run(String(i), JSON.stringify(task(String(i))));
    db.close();
  }
  const request = source === "settings" ? { cwd: f.cwd, source, settings } : { cwd: f.cwd, source };
  const first = await s.index(request);
  assert.equal(first.complete, true); assert.equal(first.indexed, 130); assert.equal(first.total, 130);
  assert.equal(f.calls.flat().length, 130);
  assert.ok(f.calls.every(batch => batch.length <= 16));
  assert.deepEqual(await s.index(request), { source, complete: true, indexed: 130, total: 130 });
  assert.equal(f.calls.flat().length, 130); await s.index(request); assert.equal(f.calls.flat().length, 130);
});

test("duplicate explicit clicks share paid work; one cancelled waiter leaves the other alive", async t => {
  const f = await fixture(t), started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => { f.calls.push([...inputs]); started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]); } });
  const a = new AbortController(), b = new AbortController();
  const request = { cwd: f.cwd, source: "settings" as const, settings: [setting("a")] };
  const first = s.index(request, a.signal); const second = s.index(request, b.signal);
  await started.promise; a.abort(); await assert.rejects(first);
  release.resolve(); assert.equal((await second).complete, true);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("vectors").length, 1);
});

for (const boundary of ["caller", "workspace", "config", "dispose"] as const) test(`explicit ${boundary} cancellation fences noncooperative provider completion`, async t => {
  const f = await fixture(t); await f.put(task("a")); const started = gate<void>(), release = gate<void>();
  let providerSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => { f.calls.push([...inputs]); providerSignal = signal; started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]); } });
  const controller = new AbortController();
  const operation = s.index({ cwd: f.cwd, source: "tasks" }, controller.signal);
  const rejected = assert.rejects(operation); await started.promise;
  const cancellation = (async () => {
    if (boundary === "caller") controller.abort();
    if (boundary === "workspace") { const other = join(f.cwd, "other"); await mkdir(other); await s.config({ cwd: other }); }
    if (boundary === "config") { await f.configure(false); await s.config({ cwd: f.cwd }); }
    if (boundary === "dispose") await s.dispose();
  })();
  try { await until(() => providerSignal!.aborted); }
  finally { release.resolve(); }
  // Config/dispose must retain ownership until the noncooperative transport ends.
  await cancellation; await rejected; await s.dispose();
  assert.equal(f.rows("pix_task_vectors").length, 0); assert.equal(f.calls.length, 1); assert.equal(f.listeners.size, 0);
});

test("late explicit catalogue consent cannot overwrite a newer automatic catalogue", async t => {
  const f = await fixture(t), preferences = new SearchPreferences(f.configPath);
  const read = preferences.embedding.bind(preferences); let hold = false;
  const entered = gate<void>(), release = gate<void>();
  preferences.embedding = async () => { const config = await read(); if (hold) { hold = false; entered.resolve(); await release.promise; } return config; };
  const s = f.make({ preferences }); await s.config({ cwd: f.cwd }); hold = true;
  const old = s.index({ cwd: f.cwd, source: "settings", settings: [setting("old")] }); await entered.promise;
  await s.sync({ cwd: f.cwd, settings: [setting("new")] }); await f.idle(s); release.resolve();
  assert.equal((await old).complete, false);
  assert.deepEqual(f.rows("documents").map(row => row.id), ["settings:new"]); assert.equal(f.calls.length, 1);
});

test("cancelled catalogue replacement cannot inherit an old automatic worker's unbounded retry", async t => {
  const f = await fixture(t), started = gate<void>(), release = gate<void>(); let block = true;
  let oldSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => { f.calls.push([...inputs]); if (block) { oldSignal = signal; started.resolve(); await release.promise; } return inputs.map(() => [1, 0, 0]); } });
  await s.sync({ cwd: f.cwd, settings: [setting("old")] }); await started.promise;
  const caller = new AbortController();
  const pending = s.index({ cwd: f.cwd, source: "settings", settings: [setting("new")] }, caller.signal);
  const checked = assert.rejects(pending);
  await until(() => oldSignal!.aborted);
  caller.abort(); await checked; block = false; release.resolve();
  await f.idle(s); await delay(30);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("vectors").length, 0);
  assert.equal((await s.index({ cwd: f.cwd, source: "settings", settings: [setting("new")] })).complete, true);
  assert.equal(f.calls.length, 2);
});

test("sessions click reuses saved names and reports changed discovery as partial", async t => {
  const f = await fixture(t); await f.put(task("a")); let calls = 0, renameAfterEmbed = false;
  await writeFile(join(f.cwd,"named.jsonl"),JSON.stringify({type:"session",id:"named",cwd:f.cwd})+"\n");
  const named = (title: string) => ({ sessionId: "named", piSessionId: "named", piSessionPath: join(f.cwd, "named.jsonl"), cwd: f.cwd,
    title, namedTitle: title, updatedAt: "2026-10-10T00:00:00Z" });
  let title = "Explicit title";
  const s = f.make({ discover: async () => { calls++; return [named(title), { ...named("First message SECRET"), sessionId: "unnamed", namedTitle: undefined }]; },
    embed: async inputs => { f.calls.push([...inputs]); if (renameAfterEmbed) title = "New saved name"; return inputs.map(() => [1, 0, 0]); } });
  assert.deepEqual(await s.index({ cwd: f.cwd, source: "sessions" }), { source: "sessions", complete: true, indexed: 1, total: 1 });
  assert.equal(calls, 2, "the refreshed session list also serves the chunk pass");
  assert.deepEqual(f.calls.flat(), ["search_document: Explicit title"]);
  assert.equal(f.rows("pix_task_vectors").length, 0); assert.equal(f.rows("vectors").length, 0); assert.equal(f.listeners.size, 0);
  await s.index({ cwd: f.cwd, source: "sessions" }); assert.equal(f.calls.length, 1);
  title = "Changed saved name"; renameAfterEmbed = true;
  const partial = await s.index({ cwd: f.cwd, source: "sessions" });
  assert.equal(partial.complete, false); assert.equal(partial.indexed, 0); assert.equal(partial.total, 1);
  renameAfterEmbed = false; assert.equal((await s.index({ cwd: f.cwd, source: "sessions" })).complete, true);
  assert.doesNotMatch(JSON.stringify(f.calls), /SECRET/);
});

test("explicit sessions pass drains 130 names in batches of at most 16 and reuses them", async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 130 }, (_, i) => ({ sessionId: `s${i}`, piSessionId: `s${i}`,
    piSessionPath: join(f.cwd, `s${i}.jsonl`), cwd: f.cwd, title: `Saved name ${i}`, namedTitle: `Saved name ${i}`,
    updatedAt: "2026-10-10T00:00:00Z" }));
  const s = f.make({ discover: async () => records });
  for(const r of records) await writeFile(r.piSessionPath,JSON.stringify({type:"session",id:r.piSessionId,cwd:f.cwd})+"\n");
  assert.deepEqual(await s.index({ cwd: f.cwd, source: "sessions" }), { source: "sessions", complete: true, indexed: 130, total: 130 });
  assert.equal(f.calls.flat().length, 130);
  assert.ok(f.calls.every(batch => batch.length <= 16));
  await s.index({ cwd: f.cwd, source: "sessions" });
  assert.equal(f.calls.flat().length, 130);
});

test("Sessions Continue resets exhausted ownership before reconciling saved names", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd,"named.jsonl"),JSON.stringify({type:"session",id:"named",cwd:f.cwd})+"\n");
  let title = "First saved name";
  const s = f.make({ discover: async () => [{ sessionId: "named", piSessionId: "named",
    piSessionPath: join(f.cwd, "named.jsonl"), cwd: f.cwd, title, namedTitle: title,
    updatedAt: "2026-10-10T00:00:00Z" }] });
  assert.equal((await s.index({ cwd: f.cwd, source: "sessions" })).complete, true);
  const db = new DatabaseSync(join(f.cwd, ".pi/search/sessions.sqlite"));
  db.exec("UPDATE pix_search_work SET failures=2,expires=0,token=''"); db.close();
  title = "Changed saved name";
  assert.equal((await s.index({ cwd: f.cwd, source: "sessions" })).complete, true);
  assert.equal(f.calls.length, 2);
});

test("explicit incompatible settings cache is retained while task-only click still succeeds", async t => {
  const f = await fixture(t), s = f.make(); await f.put(task("a"));
  await s.index({ cwd: f.cwd, source: "settings", settings: [setting("old")] });
  const db = new DatabaseSync(canonicalSearchIndexPath(f.cwd));
  db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run("other-provider"); db.close();
  const tables = ["metadata", "documents", "vectors"], before = tables.map(table => f.rows(table));
  const result = await s.index({ cwd: f.cwd, source: "settings", settings: [setting("new")] });
  assert.equal(result.complete, false); assert.equal(result.message, SEARCH_CACHE_REBUILD_REQUIRED);
  assert.deepEqual(tables.map(table => f.rows(table)), before);
  assert.equal((await s.index({ cwd: f.cwd, source: "tasks" })).complete, true);
  assert.equal(f.calls.length, 2); assert.deepEqual(tables.map(table => f.rows(table)), before);
});

for (const source of ["settings", "tasks", "sessions"] as const) test(`explicit ${source} completion cannot publish stale coverage after final consent`, async t => {
  const f = await fixture(t); await f.put(task("a"));
  const preferences = new SearchPreferences(f.configPath), read = preferences.embedding.bind(preferences);
  const entered = gate<void>(), release = gate<void>(); let hold = true;
  const store = new SearchIndexStore();
  let coverageRead = source !== "tasks";
  const readTaskVectors = store.readTaskVectors.bind(store);
  store.readTaskVectors = async (...args) => {
    const vectors = await readTaskVectors(...args);
    coverageRead = true;
    return vectors;
  };
  const table = source === "settings" ? "vectors" : source === "tasks" ? "pix_task_vectors" : "pix_session_vectors";
  preferences.embedding = async () => {
    const config = await read();
    const exists = await access(canonicalSearchIndexPath(f.cwd, source)).then(() => true, () => false);
    if (hold && coverageRead && exists && f.rows(table).length) { hold = false; entered.resolve(); await release.promise; }
    return config;
  };
  const s = f.make({ preferences, store, discover: async () => [{ sessionId: "named", piSessionId: "named", piSessionPath: join(f.cwd, "named.jsonl"), cwd: f.cwd,
    title: "Saved name", namedTitle: "Saved name", updatedAt: "2026-10-10T00:00:00Z" }] });
  const request = source === "settings" ? { cwd: f.cwd, source, settings: [setting("old")] } : { cwd: f.cwd, source };
  const pending = s.index(request); await entered.promise;
  if (source === "settings") await s.query({ cwd: f.cwd, query: "", types: ["settings"], settings: [setting("new")], limit: 10 });
  if (source === "tasks") await f.put(task("a", "New canonical title"));
  if (source === "sessions") s.changed(f.cwd);
  release.resolve(); const result = await pending; assert.equal(result.complete, false);
  if (source === "tasks") { assert.equal(result.indexed, 0); assert.equal(result.total, 1); }
});

test("sync requires catalogue and absolute cwd, reconstructs authored allowlist", () => {
  const cwd = resolve(".");
  for (const value of [{ cwd }, { cwd, settings: null }, { cwd: ".", settings: [] }, { cwd, settings: [], enabled: true }]) {
    assert.throws(() => parseSearchSyncRequest(value));
  }
  const parsed = parseSearchSyncRequest({ cwd, settings: [{ ...setting("a"), value: "SECRET", draft: "PRIVATE", renderer: "new" }] });
  assert.deepEqual(parsed, { cwd, settings: [setting("a")] });
  const a = settingsDocuments([setting("a"), setting("b")]);
  const b = settingsDocuments([{ ...setting("b"), synonyms: ["first", "second"] }, setting("a")]);
  assert.equal(settingsFingerprint(a), settingsFingerprint(b));
});

test("config never activates watchers/provider; sync returns source status without awaiting batches", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => { f.calls.push([...inputs]); started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]); } });
  for (let i = 0; i < 3; i++) assert.equal((await s.config({ cwd: f.cwd })).indexing, false);
  assert.equal(f.listeners.size, 0); assert.deepEqual(f.calls, []);
  await assert.rejects(access(join(f.cwd, ".pi/search")), { code: "ENOENT" });
  const result = await s.sync({ cwd: f.cwd, settings: [setting("a")] });
  assert.equal(result.indexing, true); assert.equal(result.indexingSources?.settings, true);
  assert.equal(result.indexingSources?.tasks, false); assert.equal(result.checkingSources?.tasks, true);
  assert.equal(f.listeners.size, 1);
  await started.promise;
  assert.equal((await s.config({ cwd: f.cwd })).indexing, true);
  release.resolve(); await f.idle(s);
  assert.equal(f.rows("vectors").length, 1); assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("task debounce and unchanged corpus scans are checks, not indexing", async t => {
  const f = await fixture(t); await f.put(task("a"));
  let changed!: () => void;
  let release = gate<void>();
  const indexer = new SettingsTaskIndexer({ cwd: f.cwd, signal: new AbortController().signal,
    config: { provider: "ollama", model: "fake", dimension: 3, queryPrefix: "", documentPrefix: "", baseUrl: "http://127.0.0.1:1" },
    store: new SearchIndexStore(), authorized: async () => true, enabled: source => source === "tasks",
    debounceMs: 1000, watchTasks: (_cwd, listener) => { changed = listener; return () => {}; },
    embed: async inputs => { f.calls.push([...inputs]); await release.promise; return inputs.map(() => [1, 0, 0]); },
  });
  const idle = () => until(() => !indexer.indexing.tasks && !indexer.checking.tasks);
  const check = () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      changed(); changed();
      assert.equal(indexer.checking.tasks, true, "debounce is a local check");
      assert.equal(indexer.indexing.tasks, false);
      t.mock.timers.tick(1000);
      assert.equal(indexer.checking.tasks, true, "the asynchronous scan is still a check");
      assert.equal(indexer.indexing.tasks, false);
    } finally { t.mock.timers.reset(); }
  };
  try {
    indexer.sync([]);
    assert.equal(indexer.checking.tasks, true);
    assert.equal(indexer.indexing.tasks, false);
    await until(() => f.calls.length === 1);
    assert.equal(indexer.indexing.tasks, true, "provider-backed index work is visible");
    release.resolve(); await idle();
    for (let i = 0; i < 3; i++) { check(); await idle(); }
    await f.put({ ...task("a"), status: "done" });
    check(); await idle();
    assert.equal(f.calls.length, 1, "duplicate file events and nonsemantic edits do not upload vectors");
    release = gate<void>();
    await f.put(task("a", "Changed semantic description"));
    check();
    await until(() => f.calls.length === 2);
    assert.equal(indexer.indexing.tasks, true);
    release.resolve(); await idle();
    check();
    await indexer.dispose();
    assert.equal(indexer.checking.tasks, false, "teardown clears pending check activity");
    assert.equal(indexer.indexing.tasks, false);
    assert.equal(f.calls.length, 2);
  } finally { release.resolve(); await indexer.dispose(); }
});

for (const legacy of [true, false]) test(`incompatible settings ${legacy ? "legacy" : "configured"} vectors do not block task indexing`, async t => {
  const f = await fixture(t), seed = f.make();
  await seed.sync({ cwd: f.cwd, settings: [setting("old")] }); await f.idle(seed); await seed.dispose();
  const db = new DatabaseSync(canonicalSearchIndexPath(f.cwd));
  try {
    if (legacy) db.exec("DELETE FROM metadata WHERE key='identity'");
    else db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run("different-provider-identity");
    db.exec("INSERT INTO vectors SELECT 'retained-unreferenced',vector FROM vectors LIMIT 1");
  } finally { db.close(); }
  const tables = ["metadata", "documents", "vectors"];
  const retained = tables.map(table => f.rows(table));
  f.calls.length = 0;
  await f.put(task("a"));
  const s = f.make();
  await s.sync({ cwd: f.cwd, settings: [setting("new")] }); await f.idle(s);
  const status = await s.config({ cwd: f.cwd });
  assert.equal(status.sourceErrors?.settings, SEARCH_CACHE_REBUILD_REQUIRED);
  assert.equal(status.sourceErrors?.tasks, undefined);
  assert.equal(f.rows("pix_task_vectors").length, 1);
  assert.deepEqual(tables.map(table => f.rows(table)), retained, "tasks must not relabel or replace settings vectors");
  assert.equal(f.calls.flat().length, 1, "only the new task is uploaded");
  for (let i = 0; i < 3; i++) await s.config({ cwd: f.cwd });
  assert.equal(f.calls.flat().length, 1, "diagnostic polling never retries incompatible caches");
});

test("an incompatible task namespace does not block changed settings", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const seed = f.make(); await seed.sync({ cwd: f.cwd, settings: [] }); await f.idle(seed); await seed.dispose();
  const db = new DatabaseSync(join(f.cwd, ".pi/search/tasks.sqlite"));
  try { db.exec("DELETE FROM pix_task_index_meta WHERE key='identity'"); } finally { db.close(); }
  const tables = ["pix_task_index_meta", "pix_task_documents", "pix_task_vectors"];
  const retained = tables.map(table => f.rows(table)); f.calls.length = 0;
  const s = f.make(); await s.sync({ cwd: f.cwd, settings: [setting("new")] }); await f.idle(s);
  const status = await s.config({ cwd: f.cwd });
  assert.equal(status.sourceErrors?.settings, undefined);
  assert.equal(status.sourceErrors?.tasks, SEARCH_CACHE_REBUILD_REQUIRED);
  assert.equal(f.rows("vectors").length, 1);
  assert.deepEqual(tables.map(table => f.rows(table)), retained);
  assert.equal(f.calls.flat().length, 1);
});

test("settings catalogue changes retain shared vectors without exposing removed fields", async t => {
  const f = await fixture(t), s = f.make();
  const original = [setting("a"), setting("b")];
  await s.sync({ cwd: f.cwd, settings: original }); await f.idle(s);
  assert.equal(f.calls.flat().length, 2);
  const reordered = parseSearchSyncRequest({ cwd: f.cwd, settings: [
    { ...setting("b"), synonyms: ["first", "second"], value: "CHANGED", labelRenderer: "new code" }, setting("a")] });
  await s.sync(reordered); await f.idle(s); assert.equal(f.calls.flat().length, 2);
  // A different field id can share a purchased metadata vector.
  await s.sync({ cwd: f.cwd, settings: [{ ...setting("a"), id: "renamed" }, setting("b", "Edited description")] }); await f.idle(s);
  assert.equal(f.calls.flat().length, 3); assert.equal(f.rows("vectors").length, 3);
  assert.deepEqual(f.rows("documents").map(row => row.id).sort(), ["settings:a", "settings:b", "settings:renamed"]);
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  assert.equal(f.rows("documents").length, 3); assert.equal(f.rows("vectors").length, 3);
  assert.deepEqual((await s.query({ cwd: f.cwd, query: "", types: ["settings"], settings: [], limit: 5 })).results, []);
  assert.equal(f.calls.flat().length, 3);
});

test("late older sync/query consent cannot replace a newer authored catalogue", async t => {
  const f = await fixture(t), preferences = new SearchPreferences(f.configPath);
  const read = preferences.embedding.bind(preferences);
  let hold = false, entered = gate<void>(), release = gate<void>();
  preferences.embedding = async () => {
    const config = await read();
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return config;
  };
  const s = f.make({ preferences }); await s.config({ cwd: f.cwd });
  hold = true;
  const olderSync = s.sync({ cwd: f.cwd, settings: [setting("older")] }); await entered.promise;
  await s.sync({ cwd: f.cwd, settings: [setting("newer")] }); await f.idle(s);
  release.resolve(); await olderSync;
  assert.deepEqual(f.rows("documents").map(row => row.id), ["settings:newer"]);
  entered = gate<void>(); release = gate<void>(); hold = true;
  const olderQuery = s.query({ cwd: f.cwd, query: "", types: ["settings"], settings: [setting("older-query")], limit: 5 }); await entered.promise;
  await s.sync({ cwd: f.cwd, settings: [setting("newest")] }); await f.idle(s);
  release.resolve(); await olderQuery; await f.idle(s);
  assert.deepEqual(f.rows("documents").map(row => row.id).sort(), ["settings:newer", "settings:newest"]);
  assert.equal(f.calls.flat().length, 2, "obsolete catalogue requests never reach the provider");
});

test("restart bootstrap catches offline task/catalogue edits, reuses unchanged and prunes removed", async t => {
  const f = await fixture(t), first = f.make();
  await f.put(task("keep")); await f.put(task("edit")); await f.put(task("remove"));
  await first.sync({ cwd: f.cwd, settings: [setting("keep"), setting("edit"), setting("remove")] }); await f.idle(first);
  const before = f.calls.flat().length; await first.dispose();
  await f.put(task("edit", "offline revised"));
  const db = await f.openTasks(); db.prepare("DELETE FROM tasks WHERE id='remove'").run(); db.close();
  const second = f.make();
  await second.sync({ cwd: f.cwd, settings: [setting("keep"), setting("edit", "offline revised")] }); await f.idle(second);
  assert.equal(f.calls.flat().length, before + 2);
  assert.deepEqual(f.rows("pix_task_documents").map(row => row.task_id).sort(), ["edit", "keep"]);
  assert.equal(f.rows("vectors").length, 4); assert.equal(f.rows("pix_task_vectors").length, 2);
});

test("settings and task corpora drain beyond 64 in bounded batches without queries", async t => {
  const f = await fixture(t), s = f.make(), db = await f.openTasks();
  for (let i = 0; i < 130; i++) db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run(String(i), JSON.stringify(task(String(i))));
  db.close();
  await s.sync({ cwd: f.cwd, settings: Array.from({ length: 80 }, (_, i) => setting(String(i))) }); await f.idle(s);
  assert.equal(f.rows("vectors").length, 80); assert.equal(f.rows("pix_task_vectors").length, 130);
  assert.ok(f.calls.every(inputs => inputs.length <= 16)); assert.equal(f.calls.flat().length, 210);
});

test("a status-only task write during a batch neither cancels nor re-embeds", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>(); let aborted = false;
  const s = f.make({ embed: async (inputs, _key, signal) => {
    f.calls.push([...inputs]); signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]);
  } });
  await s.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  await f.put({ ...task("a"), status: "done" }); await delay(20);
  assert.equal(aborted, false); release.resolve(); await f.idle(s);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("catalogue replacement fences uncooperative old settings output and indexes the new revision", async t => {
  const f = await fixture(t), started = gate<void>(), release = gate<void>();
  const old = setting("a", "old"), next = setting("a", "new");
  let providerSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => {
    f.calls.push([...inputs]); if (inputs.some(text => text.includes("\nold\n"))) { providerSignal = signal; started.resolve(); await release.promise; }
    return inputs.map(() => [1, 0, 0]);
  } });
  await s.sync({ cwd: f.cwd, settings: [old] }); await started.promise;
  await s.sync({ cwd: f.cwd, settings: [next] });
  try { await until(() => providerSignal!.aborted); assert.equal(f.calls.length, 1); }
  finally { release.resolve(); }
  await f.idle(s);
  assert.deepEqual(f.rows("vectors").map(row => row.hash), [hashText(settingsDocuments([next])[0]!.chunks[0]!)]);
  assert.equal(f.calls.length, 2);
});

test("provider errors remain source-specific and do not create a failure retry loop", async t => {
  const f = await fixture(t); await f.put(task("a")); let fail = true;
  const s = f.make({ embed: async inputs => { f.calls.push([...inputs]); if (fail) throw new Error("SECRET endpoint"); return inputs.map(() => [1, 0, 0]); } });
  await s.sync({ cwd: f.cwd, settings: [setting("a")] }); await f.idle(s);
  const status = await s.config({ cwd: f.cwd }); assert.match(status.sourceErrors?.settings ?? "", /unavailable/);
  assert.match(status.sourceErrors?.tasks ?? "", /unavailable/); assert.doesNotMatch(JSON.stringify(status), /SECRET|endpoint/);
  const before = f.calls.length;
  for (let i = 0; i < 3; i++) {
    await s.config({ cwd: f.cwd }); f.notify();
    assert.deepEqual((await s.queryTasks({ cwd: f.cwd, query: "meaning", limit: 5 })).results, []);
    await s.query({ cwd: f.cwd, settings: [setting("a")], types: ["settings"], query: "", limit: 10 });
    await f.idle(s);
  }
  assert.equal(f.calls.length, before);
  fail = false; await s.sync({ cwd: f.cwd, settings: [setting("a")] }); await f.idle(s);
  assert.equal(f.calls.length, before + 2); assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
});

test("workspace switch, revocation and dispose release watchers/timers and reject stale provider output", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>(); let blocked = true;
  const s = f.make({ embed: async inputs => { f.calls.push([...inputs]); if (blocked) { started.resolve(); await release.promise; } return inputs.map(() => [1, 0, 0]); } });
  await s.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  f.notify(); // Own a pending debounce timer at the workspace boundary.
  const other = join(f.cwd, "other"); await mkdir(other);
  await enableSearchSources(other);
  blocked = false; await s.sync({ cwd: other, settings: [setting("other")] }); await f.idle(s, other);
  assert.equal(f.closed(), 1); assert.equal(f.listeners.size, 1);
  release.resolve(); await delay(20); assert.deepEqual(f.rows("pix_task_vectors"), []);
  await f.configure(false); await s.config({ cwd: other });
  assert.equal(f.listeners.size, 0); assert.equal(f.closed(), 2);
  const before = f.calls.length; f.notify(); await delay(10); assert.equal(f.calls.length, before);
  await f.configure(); await s.sync({ cwd: other, settings: [setting("other")] }); await f.idle(s, other);
  assert.equal(f.listeners.size, 1); await s.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.closed(), 3);
});

test("tasks finish independently while Settings is blocked in the provider", async t => {
  const f = await fixture(t), started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    f.calls.push([...inputs]);
    if (inputs.some(input => input.includes("Label slow"))) { started.resolve(); await release.promise; }
    return inputs.map(() => [1, 0, 0]);
  } });
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  await s.sync({ cwd: f.cwd, settings: [setting("slow")] }); await started.promise;
  try {
    await f.put(task("a"));
    await until(async () => f.rows("pix_task_vectors").length === 1 && !(await s.config({ cwd: f.cwd })).indexingSources?.tasks);
    const waiting = await s.config({ cwd: f.cwd });
    assert.equal(waiting.indexingSources?.tasks, false);
    assert.equal(waiting.indexingSources?.settings, true);
    assert.equal(waiting.sourceErrors?.tasks, undefined);
    assert.equal(f.calls.length, 2, "Tasks can finish without waiting for Settings; status reads cannot restart provider work");
  } finally { release.resolve(); }
  await f.idle(s);
  const recovered = await s.config({ cwd: f.cwd });
  assert.equal(recovered.sourceErrors, undefined); assert.equal(recovered.indexing, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.rows("vectors").length, 1); assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("same-store background task writers serialize provider work and reuse the committed batch", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>();
  const embed: Embedder = async inputs => { f.calls.push([...inputs]); started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]); };
  const a = f.make({ embed }), b = f.make({ embed });
  await Promise.all([a.config({ cwd: f.cwd }), b.config({ cwd: f.cwd })]);
  await a.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  await b.sync({ cwd: f.cwd, settings: [] }); release.resolve(); await Promise.all([f.idle(a), f.idle(b)]);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("deletion during a noncooperative batch rolls back old task output and automatically prunes", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>();
  let providerSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => { f.calls.push([...inputs]); providerSignal = signal; started.resolve(); await release.promise; return inputs.map(() => [1, 0, 0]); } });
  await s.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  const db = await f.openTasks(); db.prepare("DELETE FROM tasks WHERE id='a'").run(); db.close(); f.notify();
  try { await until(() => providerSignal!.aborted); }
  finally { release.resolve(); }
  await f.idle(s);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.rows("pix_task_documents"), []); assert.deepEqual(f.rows("pix_task_vectors"), []);
});

test("invalid change during a batch cancels old output without repeatedly scheduling the old corpus", async t => {
  const f = await fixture(t); await f.put(task("a"));
  const started = gate<void>(), release = gate<void>(); let first = true;
  let providerSignal: AbortSignal | undefined;
  const s = f.make({ embed: async (inputs, _key, signal) => {
    f.calls.push([...inputs]); if (first) { providerSignal = signal; first = false; started.resolve(); await release.promise; }
    return inputs.map(() => [1, 0, 0]);
  } });
  await s.sync({ cwd: f.cwd, settings: [] }); await started.promise;
  const db = await f.openTasks();
  db.prepare("UPDATE tasks SET payload=? WHERE id='a'").run(JSON.stringify({ ...task("a"), parentId: "missing" })); db.close(); f.notify();
  try { await until(() => providerSignal!.aborted); }
  finally { release.resolve(); }
  await f.idle(s); assert.match((await s.config({ cwd: f.cwd })).sourceErrors?.tasks ?? "", /Task corpus unavailable/);
  f.notify(); await delay(15); await f.idle(s);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.rows("pix_task_vectors"), []);
  await f.put(task("a", "valid again")); await f.idle(s);
  assert.equal(f.calls.length, 2); assert.equal(f.rows("pix_task_vectors").length, 1);
});

test("watch failures are reported, released and retried only by an explicit sync", async t => {
  const f = await fixture(t); let attempts = 0, closed = 0;
  const s = f.make({ watchTasks: (_cwd, _changed, failed) => {
    attempts++; if (attempts === 1) failed(new Error("SECRET filesystem")); return () => { closed++; };
  } });
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  assert.match((await s.config({ cwd: f.cwd })).sourceErrors?.tasks ?? "", /watcher unavailable/);
  assert.equal(closed, 1);
  await s.queryTasks({ cwd: f.cwd, query: "none", limit: 5 }); await s.config({ cwd: f.cwd });
  assert.equal(attempts, 1);
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  assert.equal(attempts, 2); assert.equal((await s.config({ cwd: f.cwd })).sourceErrors, undefined);
  await s.dispose(); assert.equal(closed, 2);
});

test("native directory watcher sees task database creation, external WAL updates and atomic replacement", async t => {
  const f = await fixture(t), s = f.make({ watchTasks: undefined, taskDebounceMs: 5 });
  // No .pi exists before activation. Remove the initialized directory while owned
  // to exercise recreation too, not just initial bootstrap.
  await s.sync({ cwd: f.cwd, settings: [] }); await f.idle(s);
  await rm(join(f.cwd, ".pi"), { recursive: true, force: true });
  // Directory recreation must explicitly restore the source opt-in too.
  await enableSearchSources(f.cwd);
  const db = await f.openTasks();
  db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run("a", JSON.stringify(task("a")));
  try {
    await until(() => f.calls.flat().some(text => text.includes("Task title: Title a")));
    await f.idle(s);
    db.prepare("UPDATE tasks SET payload=? WHERE id='a'").run(JSON.stringify(task("a", "external WAL version")));
    try { await until(() => f.calls.flat().some(text => text.includes("external WAL version"))); }
    catch (error) { assert.fail(`${String(error)}; ${JSON.stringify(await s.config({ cwd: f.cwd }))}; calls=${JSON.stringify(f.calls)}`); }
    await f.idle(s);
    const before = f.calls.length;
    db.prepare("UPDATE tasks SET payload=? WHERE id='a'").run(JSON.stringify({ ...task("a", "external WAL version"), status: "done" }));
    await delay(40); await f.idle(s); assert.equal(f.calls.length, before);
  } finally { db.close(); }
  await rename(f.tasksPath, `${f.tasksPath}.old`);
  const replacement = await f.openTasks();
  replacement.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run("b", JSON.stringify(task("b"))); replacement.close();
  await until(() => f.calls.flat().some(text => text.includes("Task title: Title b"))); await f.idle(s);
  assert.deepEqual(f.rows("pix_task_documents").map(row => row.task_id), ["b"]);
  const count = f.calls.length; await delay(50); await f.idle(s); assert.equal(f.calls.length, count);
});
