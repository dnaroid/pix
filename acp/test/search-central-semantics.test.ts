import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopSearchService } from "../src/search/service.js";
import { SearchPreferences, type SearchAuth, type SemanticEmbeddingConfig } from "../src/search/config.js";
import { embedOpenRouter, type Embedder } from "../src/search/embeddings.js";
import type { SessionMapRecord } from "../src/acp/session-map.js";
import { TASK_SCHEMA } from "../src/registry/task-database.js";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < end, "Timed out waiting for fixture"); await delay(5); }
}
const embedding = { embeddingProvider: "ollama", embeddingModel: "code-model", knowledgeEmbeddingModel: "history-model",
  vectorSize: 3, knowledgeEmbeddingQueryPrefix: "Q: ", knowledgeEmbeddingDocumentPrefix: "D: ", ollamaBaseUrl: "http://127.0.0.1:11435/custom" };
const setting = { id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: [] };
const noAuth: SearchAuth = { available: async () => { throw new Error("Ollama must not consult auth"); },
  key: async () => { throw new Error("Ollama must not consult auth"); }, save: async () => { throw new Error("ACP must not write auth"); } };

async function fixture(t: TestContext) {
  const base = resolve(".pi/artifacts/central-semantics-acp/configured-fixtures");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "run-"));
  const path = join(cwd, "pi-tools-suite.jsonc");
  const preferences = new SearchPreferences(path);
  const session = join(cwd, "session.jsonl");
  await writeFile(session, JSON.stringify({ type: "session_info", name: "Named history" }) + "\n");
  const record: SessionMapRecord = { sessionId: "s1", piSessionId: "pi1", piSessionPath: session, cwd,
    title: "Named history", namedTitle: "Named history", updatedAt: new Date().toISOString() };
  const configure = (config: Record<string, unknown> = embedding) => writeFile(path, JSON.stringify({ search: { embedding: config } }));
  const calls: Array<{ input: readonly string[]; config: Parameters<Embedder>[3]; key: string }> = [];
  const embed: Embedder = async (input, key, _signal, config) => {
    calls.push({ input, key, config });
    return input.map(() => Array.from({ length: config!.dimension }, (_, i) => i === 0 ? 1 : 0));
  };
  const services: DesktopSearchService[] = [];
  const make = (options: ConstructorParameters<typeof DesktopSearchService>[0] = {}) => {
    const service = new DesktopSearchService({ preferences, auth: noAuth, embed, discover: async () => [record], ...options });
    services.push(service); return service;
  };
  const request = (query = "", types: Array<"settings" | "sessions"> = ["settings", "sessions"]) =>
    ({ cwd, query, types, settings: [setting], limit: 20 });
  const idle = (service: DesktopSearchService) => until(async () => !(await service.config({ cwd })).indexing);
  const rows = (table: string) => {
    const db = new DatabaseSync(join(cwd, ".pi/search/index.sqlite"), { readOnly: true });
    try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); }
  };
  t.after(async () => { await Promise.all(services.map(service => service.dispose())); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, path, configure, calls, embed, make, request, idle, rows, record };
}

test("configured knowledge identity, prefixes, dimensions and endpoint apply to settings, sessions and tasks without an Ollama key", async t => {
  const f = await fixture(t); await f.configure();
  const service = f.make();
  const status = await service.config({ cwd: f.cwd });
  assert.equal(status.enabled, true); assert.equal(status.sessionTitlesEnabled, true); assert.equal(status.tasksSemanticEnabled, true);
  assert.equal(status.keyAvailable, true); assert.deepEqual(f.calls, []);
  await service.query(f.request()); await f.idle(service);
  const response = await service.query(f.request("unrelated meaning"));
  assert.ok(response.results.some(hit => hit.kind === "settings"));
  assert.ok(response.results.some(hit => hit.kind === "sessions" && hit.semantic));
  await mkdir(join(f.cwd, ".pi"), { recursive: true });
  const db = new DatabaseSync(join(f.cwd, ".pi/tasks.sqlite"));
  try {
    db.exec(TASK_SCHEMA);
    db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run("t1", JSON.stringify({ id: "t1", title: "Research", description: "History notes",
      type: "feature", status: "todo", priority: "medium", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }));
  } finally { db.close(); }
  await service.sync({ cwd: f.cwd, settings: [setting] }); await f.idle(service);
  assert.equal((await service.queryTasks({ cwd: f.cwd, query: "unrelated task meaning", limit: 20 })).results[0]?.taskId, "t1");
  assert.ok(f.calls.some(call => call.input.includes("D: appearance\nTheme\nColor scheme")));
  assert.ok(f.calls.some(call => call.input.includes("D: Named history")));
  assert.ok(f.calls.some(call => call.input.some(text => text.startsWith("D: Task title:"))));
  assert.ok(f.calls.some(call => call.input.includes("Q: unrelated meaning")));
  assert.ok(f.calls.every(call => call.key === "" && call.config?.provider === "ollama" && call.config.model === "history-model"
    && call.config.dimension === 3 && call.config.baseUrl === embedding.ollamaBaseUrl));
  for (const table of ["metadata", "pix_session_meta", "pix_task_index_meta"]) {
    const rows = f.rows(table);
    assert.equal(rows.find(row => row.key === "model")?.value, "history-model");
    assert.equal(rows.find(row => row.key === "dimensions")?.value, "3");
    assert.equal(rows.find(row => row.key === "identity")?.value, f.rows("metadata").find(row => row.key === "identity")?.value);
  }
  const before = f.calls.length;
  await f.make().query(f.request("restarted lookup"));
  assert.ok(f.calls.slice(before).every(call => call.input.every(text => text.startsWith("Q: "))), "restart reuses configured paid document vectors");
});

test("ACP accepts only suite search.embedding; suite enabled:false and project/legacy settings do not authorize", async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, ".pi/search"), { recursive: true });
  await writeFile(join(f.cwd, ".pi/search/semantic.json"), JSON.stringify({ enabled: true, embedding }));
  await writeFile(f.path, JSON.stringify({ enabled: false, embedding }));
  assert.equal((await f.make().config({ cwd: f.cwd })).enabled, false);
  await writeFile(f.path, `{
    // A suite switch is unrelated to explicit global semantic authorization.
    "enabled": false,
    "search": { "embedding": ${JSON.stringify(embedding)} }
  }`);
  const status = await f.make().config({ cwd: f.cwd });
  assert.equal(status.enabled, true, "the explicitly configured global embedding authorizes independently of unrelated suite switches");
});

test("identity changes invalidate query reuse and retain incompatible purchased settings/session vectors", async t => {
  const f = await fixture(t); await f.configure();
  const service = f.make(); await service.query(f.request()); await f.idle(service);
  await service.query(f.request("shared lookup")); await f.idle(service);
  const snapshot = ["metadata", "vectors", "pix_session_meta", "pix_session_vectors"].map(table => f.rows(table));
  assert.equal(f.calls.filter(call => call.input.includes("Q: shared lookup")).length, 1);
  await f.configure({ ...embedding, knowledgeEmbeddingModel: "new-history-model", vectorSize: 4, ollamaBaseUrl: "http://127.0.0.1:11436" });
  const response = await service.query(f.request("shared lookup")); await f.idle(service);
  assert.equal(response.results.length, 0, "incompatible paid vectors must not create semantic hits");
  const newCalls = f.calls.filter(call => call.config?.model === "new-history-model");
  assert.ok(newCalls.some(call => call.input.includes("Q: shared lookup")), "old query vector was not reused");
  assert.ok(newCalls.every(call => call.input.every(text => text.startsWith("Q: "))), "no paid rebuild of incompatible history cache");
  assert.deepEqual(["metadata", "vectors", "pix_session_meta", "pix_session_vectors"].map(table => f.rows(table)), snapshot);
  assert.match((await service.config({ cwd: f.cwd })).error ?? "", /unavailable|incompatible/i);
});

test("configuration removed during credential availability never restores old consent", async t => {
  const f = await fixture(t); await f.configure({ ...embedding, embeddingProvider: "openrouter" });
  const started = gate<void>(); const release = gate<boolean>();
  const service = f.make({ auth: { ...noAuth, available: async () => { started.resolve(); return release.promise; } } });
  const status = service.config({ cwd: f.cwd }); await started.promise;
  await rm(f.path);
  assert.equal((await service.query({ ...f.request(), types: [], settings: [] })).status.enabled, false, "newer query sees revocation first");
  release.resolve(true);
  const result = await status;
  assert.equal(result.enabled, false); assert.equal(result.tasksSemanticEnabled, false); assert.equal(result.sessionTitlesEnabled, false);
  assert.deepEqual(f.calls, []);
});

test("configuration removed during key lookup suppresses the provider request without an ACP notification", async t => {
  const f = await fixture(t); await f.configure({ ...embedding, embeddingProvider: "openrouter" });
  const started = gate<void>(); const release = gate<string>();
  const service = f.make({ auth: { ...noAuth, available: async () => true, key: async () => { started.resolve(); return release.promise; } } });
  const query = service.query(f.request("needle", ["settings"])); await started.promise;
  await rm(f.path); release.resolve("mock-only");
  assert.deepEqual((await query).results, []); await f.idle(service);
  assert.deepEqual(f.calls, []);
  assert.equal((await service.config({ cwd: f.cwd })).enabled, false);
  assert.deepEqual(f.rows("vectors"), []);
});

test("revocation during discovery suppresses a previously cached semantic query", async t => {
  const f = await fixture(t); await f.configure();
  const started = gate<void>(); const release = gate<void>(); let paused = false;
  const service = f.make({ discover: async () => { if (paused) { started.resolve(); await release.promise; } return [f.record]; } });
  await service.query(f.request()); await f.idle(service);
  assert.ok((await service.query(f.request("semantic meaning", ["sessions"]))).results.some(hit => hit.kind === "sessions" && hit.semantic));
  const count = f.calls.length; paused = true;
  const query = service.query(f.request("semantic meaning", ["sessions"])); await started.promise;
  await rm(f.path); release.resolve();
  assert.deepEqual((await query).results, []);
  assert.equal(f.calls.length, count);
});

test("configured HTTP transports use the knowledge model, custom dimensions and Ollama endpoint without leaking auth", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const config: SemanticEmbeddingConfig = { provider: "ollama", model: "history-model", dimension: 3,
    queryPrefix: "Q: ", documentPrefix: "D: ", baseUrl: "http://127.0.0.1:11435/custom" };
  const inputs = ["Q: lookup"];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), config.baseUrl + "/api/embed");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "history-model", input: inputs, truncate: true });
    return new Response(JSON.stringify({ model: "history-model", embeddings: [[1, 0, 0]] }));
  };
  assert.deepEqual(await embedOpenRouter(inputs, "ignored-secret", new AbortController().signal, config), [[1, 0, 0]]);
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer mock-only");
    assert.equal(JSON.parse(String(init?.body)).model, "provider/history-model");
    return new Response(JSON.stringify({ object: "list", model: "history-model", data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }] }));
  };
  assert.deepEqual(await embedOpenRouter(inputs, "mock-only", new AbortController().signal,
    { ...config, provider: "openrouter", model: "provider/history-model", baseUrl: "https://openrouter.ai/api/v1" }), [[1, 0, 0]]);
});
