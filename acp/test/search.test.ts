import { canonicalSearchIndexPath } from "../src/search/canonical-index.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopSearchService, type SearchIndexDiagnostic } from "../src/search/service.js";
import { SearchIndexStore, SearchIndexBusyError } from "../src/search/index-store.js";
import { sharedSearchAuth, type SearchAuth } from "../src/search/config.js";
import { FixtureSearchPreferences as SearchPreferences } from "./central-semantics-fixture.js";
import { SEARCH_EMBEDDING_MODEL, type SearchQueryRequest } from "../src/search/contract.js";
import { decodeEmbeddings, embedOpenRouter, EMBEDDING_DIMENSIONS, EMBEDDING_ENDPOINT, type Embedder } from "../src/search/embeddings.js";
import { hashText, settingsDocuments } from "../src/search/documents.js";
import { parseSearchQueryRequest, parseSearchConfigRequest } from "../src/search/request.js";
import type { SessionMapRecord } from "../src/acp/session-map.js";
import { synchronizeSessionBoundaries } from "../src/search/session-boundary-service.js";
import { indexSessionChunks } from "../src/search/session-chunks.js";
import { enableSearchSources, isolateSearchHome } from "./search-sources-fixture.js";

const signal = () => new AbortController().signal;
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean | Promise<boolean>, message = "condition") {
  const end = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < end, `Timed out waiting for ${message}`); await delay(10); }
}
function rows(cwd: string, table: "documents" | "vectors" | "metadata" | "sqlite_master"
  | "pix_session_titles" | "pix_session_vectors" | "pix_session_meta" | "pix_commit_vectors",
  source: "sessions" | "commits" | "settings" = table.startsWith("pix_session_") ? "sessions" : table.startsWith("pix_commit_") ? "commits" : "settings") {
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(canonicalSearchIndexPath(cwd, source), { readOnly: true }); return db.prepare(`SELECT * FROM ${table}`).all(); }
  catch { return []; } finally { db?.close(); }
}
const setting = { id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: ["dark"] };
test("explicit index diagnostics contain metadata only and cannot break indexing", async t => {
  const f = await fixture(t);
  const records: SearchIndexDiagnostic[] = [];
  const s = f.make({ onIndexDiagnostic: record => {
    records.push(record);
    throw new Error("broken logging sink");
  } });
  const secret = "private-setting-description-never-in-diagnostics";
  const request = { cwd: f.cwd, source: "settings" as const, settings: [{ ...setting, description: secret }] };
  const unavailable = await s.index(request);
  assert.equal(unavailable.complete, false);
  assert.equal(records[0]?.complete, false);
  await f.preferences.configure();
  const result = await s.index(request);
  assert.equal(records.length, 2);
  assert.deepEqual(records[1], { cwd: f.cwd, source: "settings", complete: result.complete,
    indexed: result.indexed, total: result.total, durationMs: records[1]!.durationMs });
  assert.ok(records[1]!.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(records), /private-setting-description-never-in-diagnostics|broken logging sink/);
});
async function fixture(t: TestContext) {
  const artifacts = resolve(".pi/artifacts/central-semantics-acp/session-fixtures");
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, "run-"));
  const restoreHome = await isolateSearchHome(cwd);
  await enableSearchSources(cwd);
  const path = join(cwd, "session.jsonl");
  const preferences = new SearchPreferences(join(cwd, "semantic-search.json"));
  const record: SessionMapRecord = { sessionId: "s1", piSessionPath: path, piSessionId: "pi1", cwd, title: "Модель для эмбеддинга", updatedAt: new Date().toISOString() };
  let records = [record];
  let key: string | undefined = "mock-only";
  const auth: SearchAuth = { available: async () => Boolean(key), key: async () => key, save: async value => { key = value || undefined; } };
  const calls: string[][] = [];
  const embed: Embedder = async inputs => { calls.push([...inputs]); return inputs.map(vector); };
  const services: DesktopSearchService[] = [];
  const make = (overrides: Partial<ConstructorParameters<typeof DesktopSearchService>[0]> = {}) => {
    const service = new DesktopSearchService({ discover: async () => records, sessionRecords: async () => records, preferences, auth, embed, ...overrides });
    services.push(service); return service;
  };
  t.after(async () => { await Promise.all(services.map(s => s.dispose())); await rm(cwd, { recursive: true, force: true }); restoreHome(); });
  const request = (query = "", extra = {}): SearchQueryRequest => ({ cwd, query, types: ["sessions"], settings: [], limit: 30, ...extra });
  const idle = async (s: DesktopSearchService) => until(async () => {
    const status = await s.config({ cwd });
    return !status.indexing && !status.checkingSources?.tasks;
  }, "index idle");
  const index = () => indexSessionChunks(cwd,[{id:record.piSessionId,path}],{signal:signal()});
  const publish = async (name = record.title!) => {
    await writeFile(path,[{type:"session",id:record.piSessionId,cwd},
      {type:"session_info",id:"name",parentId:null,name}].map(r=>JSON.stringify(r)).join("\n")+"\n");
    await index();
  };
  await publish();
  return { cwd, path, preferences, record, calls, make, request, idle, index, publish,
    setRecords: (value: SessionMapRecord[]) => { records = value; }, setKey: (value?: string) => { key = value; } };
}

test("strict float/base64 decoding rejects malformed, quantized, zero, duplicate and nonfinite vectors", () => {
  const response = (embedding: unknown) => ({ object: "list", model: SEARCH_EMBEDDING_MODEL, data: [{ object: "embedding", index: 0, embedding }] });
  assert.deepEqual(decodeEmbeddings(response(vector()), 1), [vector()]);
  const bytes = Buffer.alloc(4096); bytes.writeFloatLE(1);
  assert.deepEqual(decodeEmbeddings(response(bytes.toString("base64")), 1), [vector()]);
  for (const bad of [[], Array(1024).fill(0), Array(1024).fill(Infinity), Array(1024).fill(1e300), Array(1024).fill(1e-300), Buffer.alloc(1024).toString("base64"), bytes.toString("base64").slice(1), bytes.toString("base64") + "\n"]) assert.throws(() => decodeEmbeddings(response(bad), 1));
  bytes.writeFloatLE(NaN); assert.throws(() => decodeEmbeddings(response(bytes.toString("base64")), 1));
  assert.throws(() => decodeEmbeddings({ ...response(vector()), model: "wrong" }, 1));
  assert.throws(() => decodeEmbeddings({ ...response(vector()), data: [response(vector()).data[0], response(vector()).data[0]] }, 2));
});

test("embedding decoder accepts only the pinned routing ID and its exact provider response ID", () => {
  const bytes = Buffer.alloc(4096); bytes.writeFloatLE(1);
  const response = (model: unknown, embedding: unknown = vector()) => ({ object: "list", model, data: [{ object: "embedding", index: 0, embedding }] });
  for (const model of [SEARCH_EMBEDDING_MODEL, "pplx-embed-v1-0.6b"]) {
    assert.deepEqual(decodeEmbeddings(response(model), 1), [vector()]);
    assert.deepEqual(decodeEmbeddings(response(model, bytes.toString("base64")), 1), [vector()]);
    for (const bad of [Array(1024).fill(0), Array(1024).fill(NaN), Array(1024).fill(1e300), Array(768).fill(1)]) assert.throws(() => decodeEmbeddings(response(model, bad), 1));
  }
  for (const model of [undefined, null, 42, "", "pplx-embed-v1-4b", "perplexity/pplx-embed-v1-4b", "other/pplx-embed-v1-0.6b", "pplx-embed-v1-0.6b ", "PPLX-EMBED-V1-0.6B"]) assert.throws(() => decodeEmbeddings(response(model), 1));
});

test("malformed transcripts invalidate indexed titles without query-time fallback reads", async t => {
  const f = await fixture(t); await f.preferences.configure();
  const body = "{malformed JSONL but private bodyOnly data}";
  await writeFile(f.path, body);
  f.setRecords([f.record, f.record, { ...f.record, sessionId: "foreign", cwd: join(f.cwd, "other") },
    { ...f.record, sessionId: "empty", title: " " }]);
  const s = f.make();
  const hits = (await s.query(f.request("МОДЕЛЬ эмбеддинга"))).results;
  assert.deepEqual(hits, []);
  assert.deepEqual((await s.query(f.request("bodyOnly"))).results, []);
  assert.deepEqual((await s.query(f.request())).results, []);
  assert.deepEqual(f.calls, []);
  assert.equal(rows(f.cwd, "documents").length, 0);
  assert.equal(rows(f.cwd, "vectors").length, 0);
  assert.equal(await readFile(f.path, "utf8"), body);
});

test("local session index uses first user and last completed assistant on active branch only", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Проектный разговор" }]);
  const entry = (id: string, parentId: string | null, role: string, text: string, stopReason?: string) =>
    JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
      message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
  const content = [
    JSON.stringify({ type: "session", version: 3, id: "pi1", cwd: f.cwd }),
    entry("u1", null, "user", "первый запрос про апельсины"),
    entry("a1", "u1", "assistant", "intermediate token should not appear", "toolUse"),
    entry("a2", "a1", "assistant", "первый окончательный итог", "stop"),
    entry("u2", "a2", "user", "вторая задача"),
    entry("a3", "u2", "assistant", "obsoletebranchfinal", "stop"),
    entry("u3", "u1", "user", "новая ветка"),
    entry("a4", "u3", "assistant", "настоящийbranchfinal", "stop"),
  ].join("\n") + "\n";
  await writeFile(f.path, content);
  await f.index();
  const s = f.make();
  for (const query of ["апельсины", "настоящийbranchfinal"]) {
    const result = await s.query(f.request(query));
    assert.deepEqual(result.results.map(hit => hit.id), ["sessions:s1"]);
    assert.equal(result.results[0]?.kind, "sessions");
    assert.equal(result.results[0]?.kind === "sessions" && result.results[0].boundaryMatch, true);
  }
  for (const query of ["obsoletebranchfinal", "intermediate", "окончательный"]) {
    assert.deepEqual((await s.query(f.request(query))).results, [], query);
  }
  const indexed = rows(f.cwd, "sqlite_master", "sessions").map(row => row.name);
  assert.ok(indexed.includes("pix_session_chunk_fts"));
  assert.deepEqual(f.calls, [], "local boundary FTS never sends messages or queries to a provider");
  assert.equal(rows(f.cwd, "documents").length, 0, "settings-only legacy tables stay protected");

  await writeFile(f.path, content.replace("настоящийbranchfinal", "исправленныйfinal"));
  assert.deepEqual((await s.query(f.request("настоящийbranchfinal"))).results, []);
  assert.deepEqual((await s.query(f.request("исправленныйfinal"))).results, [], "wait for background refresh");
  await f.index();
  assert.equal((await s.query(f.request("исправленныйfinal"))).results.length, 1);
  f.setRecords([]);
  await rm(f.path);
  assert.deepEqual((await s.query(f.request("исправленныйfinal"))).results, []);
});

test("boundary refresh invalidates pre-projection cache and excludes sandbox source", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Game discussion" }]);
  const entry = (id: string, parentId: string | null, role: string, text: string) =>
    JSON.stringify({ type: "message", id, parentId, message: { role, stopReason: "stop", content: text } });
  await writeFile(f.path, [JSON.stringify({ type: "session", id: "pi1", cwd: f.cwd }),
    entry("u", null, "user", "Request\n```pix-html\nusersecret\n```\nfirstprose"),
    entry("a", "u", "assistant", "Ready\n```pix-html\nassistantsecret\n```\nfinalprose"),
  ].join("\n") + "\n");
  const store = new SearchIndexStore();
  await f.index();
  await synchronizeSessionBoundaries(store, f.cwd, [f.record], signal());
  const db = new DatabaseSync(join(f.cwd, ".pi/search/sessions.sqlite"));
  try {
    const stats = await (await import("node:fs/promises")).stat(f.path);
    db.prepare("UPDATE pix_session_boundary_meta SET fingerprint=?").run(`${stats.size}:${stats.mtimeMs}`);
    db.exec("UPDATE pix_session_boundary_fts SET final_text='assistantsecret',first_text='usersecret'");
    await synchronizeSessionBoundaries(store, f.cwd, [f.record], signal());
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM pix_session_boundary_fts").all()), /usersecret|assistantsecret/);
    const s = f.make();
    assert.equal((await s.query(f.request("finalprose"))).results.length, 1);
    for (const query of ["assistantsecret", "usersecret"]) assert.deepEqual((await s.query(f.request(query))).results, []);
  } finally { db.close(); }
});

test("private session excerpts refuse redirected SQLite index directories", async t => {
  const f = await fixture(t);
  const target = await mkdtemp(join(f.cwd, "external-"));
  await mkdir(join(f.cwd, ".pi"), { recursive: true });
  await rm(join(f.cwd,".pi/search"),{recursive:true,force:true});
  await symlink(target, join(f.cwd, ".pi", "search"));
  await writeFile(f.path, JSON.stringify({ type: "session", id: "pi1", cwd: f.cwd }) + "\n");
  await assert.rejects(
    synchronizeSessionBoundaries(new SearchIndexStore(), f.cwd, [f.record], signal()),
    /index path is unsafe/,
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(target), [], "no FTS data follows redirected paths");
});

test("explicit queries see title renames/deletions and missing body files without history scanning", async t => {
  const f = await fixture(t); const s = f.make();
  assert.equal((await s.query(f.request("модель"))).results.length, 1);
  f.setRecords([{ ...f.record, title: "Новый заголовок" }]); s.changed(f.cwd);
  await f.publish("Новый заголовок");
  assert.equal((await s.query(f.request("модель"))).results.length, 0);
  assert.equal((await s.query(f.request("заголовок"))).results.length, 1);
  f.setRecords([]);
  await rm(f.path);
  assert.equal((await s.query(f.request("заголовок"))).results.length, 0);
});

test("obsolete schema is rejected rather than migrated or rewritten", async t => {
  const f = await fixture(t), store = new SearchIndexStore();
  const docs = settingsDocuments([setting]); const hash = hashText(docs[0]!.chunks[0]!);
  await store.write(f.cwd, signal(), tx => tx.save(docs, new Map([[hash, vector()]])));
  const db = new DatabaseSync(store.path(f.cwd));
  db.exec("DROP TRIGGER settings_schema_insert; DROP TRIGGER settings_schema_update; UPDATE metadata SET value='1' WHERE key='schema'");
  db.close();
  await assert.rejects(store.write(f.cwd, signal(), async () => {}), /Incompatible search index schema/);
  assert.equal(rows(f.cwd, "metadata").find(row => row.key === "schema")?.value, "1");
  assert.deepEqual(rows(f.cwd, "vectors").map(row => row.hash), [hash]);
  assert.deepEqual(rows(f.cwd, "documents").map(row => row.id), ["settings:theme"]);
  const obsolete = join(f.cwd, ".pi/search/index.sqlite");
  await mkdir(join(f.cwd, ".pi/search"), { recursive: true });
  await writeFile(obsolete, "invalid obsolete database");
  const s = f.make(); assert.equal((await s.query(f.request("модель"))).results.length, 1);
  assert.equal(await readFile(obsolete, "utf8"), "invalid obsolete database");
  assert.deepEqual(f.calls, []);
});

test("store refuses to persist session rows and rolls back rejected/canceled transactions", async t => {
  const f = await fixture(t); const store = new SearchIndexStore();
  const docs = settingsDocuments([setting]);
  await store.write(f.cwd, signal(), tx => tx.save(docs, new Map()));
  await assert.rejects(store.write(f.cwd, signal(), tx => tx.save([{ ...docs[0]!, hit: { kind: "sessions", id: "s", sessionId: "s", title: "s", snippet: "", score: 0 } }], new Map())), /Only settings/);
  const controller = new AbortController();
  await assert.rejects(store.write(f.cwd, controller.signal, async tx => { await tx.save([], new Map()); controller.abort(); }));
  assert.equal(rows(f.cwd, "documents").length, 1);
});

test("busy settings index does not block independent local session titles", async t => {
  const f = await fixture(t); const store = new SearchIndexStore(60);
  await store.write(f.cwd, signal(), async () => {});
  const db = new DatabaseSync(store.path(f.cwd)); db.exec("BEGIN IMMEDIATE");
  const s = f.make({ store });
  const writes = t.mock.method(store, "write");
  try {
    await assert.rejects(store.write(f.cwd, signal(), async () => {}), SearchIndexBusyError);
    const result = await s.query(f.request("модель"));
    assert.equal(result.results.length, 1); assert.equal(result.status.error, undefined);
    assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  } finally { db.exec("ROLLBACK"); db.close(); }
  const attempts = writes.mock.callCount();
  assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  assert.equal(writes.mock.callCount(), attempts, "status polling never retries writes");
  await s.sync({ cwd: f.cwd, settings: [] });
  assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  assert.equal(writes.mock.callCount(), attempts, "unconfigured sync has no startup migration writes");
  await s.config({ cwd: f.cwd });
  assert.equal(writes.mock.callCount(), attempts, "status remains read-only");
  assert.deepEqual(f.calls, []);
});

test("offline settings use authored metadata, not values; settings-only queries never discover sessions", async t => {
  const f = await fixture(t); f.setKey();
  const s = f.make({ discover: async () => { throw new Error("must not discover"); } });
  const request = parseSearchQueryRequest(f.request("dark", { types: ["settings"], settings: [{ ...setting, value: "SECRET", apiKey: "SECRET" }] }));
  assert.equal((await s.query(request)).results[0]?.id, "settings:theme");
  await f.idle(s);
  assert.doesNotMatch(JSON.stringify(rows(f.cwd, "documents")), /SECRET/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => parseSearchConfigRequest({ cwd: f.cwd, messageFilterEnabled: true }));
});

test("settings embeddings persist/reuse across restart and absent transcripts do not trigger session query embeddings", async t => {
  const f = await fixture(t); await f.preferences.configure();
  await rm(f.path);
  const request = f.request("", { types: ["settings", "sessions"], settings: [setting] });
  const first = f.make(); await first.query(request); await f.idle(first);
  assert.equal(rows(f.cwd, "vectors").length, 1); await first.dispose();
  const second = f.make(); await second.query(request); await f.idle(second);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /Модель|эмбеддинга/);
  assert.equal(rows(f.cwd, "metadata").find(row => row.key === "model")?.value, SEARCH_EMBEDDING_MODEL);
  const hits = (await second.query({ ...request, query: "nonlexical" })).results;
  assert.equal(hits[0]?.id, "settings:theme");
  const before = f.calls.length;
  await second.query(f.request("модель"));
  assert.equal(f.calls.length, before, "sessions-only query remains local with populated settings cache");
});

test("central configuration indexes named titles, not fallback prompts or history", async t => {
  const f = await fixture(t);
  const privateMessage = "PRIVATE-FIRST-MESSAGE-NOT-A-TITLE";
  await writeFile(f.path, `USER: ${privateMessage}\nPRIVATE-HISTORY-TEXT\n`);
  await f.publish("Garden planning");
  f.setRecords([
    { ...f.record, title: "Garden planning", namedTitle: "Garden planning" },
    { ...f.record, sessionId: "fallback", piSessionPath: join(f.cwd,"fallback.jsonl"), title: privateMessage },
    { ...f.record, sessionId: "mismatch", piSessionPath: join(f.cwd,"mismatch.jsonl"), title: "Fresh rename", namedTitle: "Old name" },
  ]);
  const s = f.make();
  const before = await s.config({ cwd: f.cwd });
  assert.equal(before.sessionTitlesEnabled, false);
  await s.query(f.request("garden"));
  assert.deepEqual(f.calls, [], "session titles are never uploaded without central configuration");
  assert.deepEqual(rows(f.cwd, "pix_session_titles"), []);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
  assert.deepEqual(rows(f.cwd, "vectors"), []);

  await f.preferences.configure(); await s.config({ cwd: f.cwd });
  await f.idle(s);
  assert.deepEqual(f.calls, [], "consent alone does not upload an earlier title snapshot");
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(f.calls, [], "queries do not upload session documents");
  await s.index({ cwd: f.cwd, source: "sessions" });
  assert.deepEqual(f.calls, [["Garden planning"]], "only actual names may be embedded");
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE|Old name|эмбеддинга/);
  assert.match(await readFile(f.path, "utf8"), /Garden planning/);
  await s.dispose();

  const reopened = f.make();
  await reopened.query(f.request(""));
  await f.idle(reopened);
  assert.equal(f.calls.length, 1, "the durable vector must be reused after restart");
  await f.preferences.configure(false); await reopened.config({ cwd: f.cwd });
  const calls = f.calls.length;
  await reopened.query(f.request("garden"));
  assert.equal(f.calls.length, calls, "revocation keeps the lexical search local");
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1, "revocation retains the paid local cache");
});

test("session-title embeddings add non-lexical results without affecting settings or commits", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Orchard maintenance", namedTitle: "Orchard maintenance" }]);
  await f.publish("Orchard maintenance");
  await f.preferences.configure();
  const s = f.make();
  await s.index({ cwd: f.cwd, source: "sessions" });
  await f.idle(s);
  const response = await s.query(f.request("agricultural hydration"));
  assert.deepEqual(response.results.map(hit => hit.id), ["sessions:s1"]);
  assert.equal(response.results[0]?.snippet, "");
  assert.equal(rows(f.cwd, "documents").length, 0);
  assert.equal(rows(f.cwd, "vectors").length, 0);
  assert.equal(rows(f.cwd, "pix_session_titles").length, 1);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  assert.ok(rows(f.cwd, "pix_session_meta").some(row => row.key === "model" && row.value === SEARCH_EMBEDDING_MODEL));
});

test("session title rename, delete, and duplicate names reconcile only session tables", async t => {
  const f = await fixture(t);
  await f.preferences.configure();
  f.setRecords([
    { ...f.record, title: "Historic overview", namedTitle: "Historic overview" },
    { ...f.record, sessionId: "s2", title: "Historic overview", namedTitle: "Historic overview" },
  ]);
  const s = f.make();
  await s.index({ cwd: f.cwd, source: "sessions" });
  await f.idle(s);
  assert.equal(rows(f.cwd, "pix_session_titles").length, 2);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1, "same title shares a single embedding");
  const existing = rows(f.cwd, "pix_session_vectors")[0]!.title_hash;
  f.setRecords([{ ...f.record, sessionId: "s2", title: "New topic", namedTitle: "New topic" }]);
  s.changed(f.cwd);
  await s.index({ cwd: f.cwd, source: "sessions" });
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_titles").map(row => row.session_id), ["s2"]);
  assert.ok(rows(f.cwd, "pix_session_vectors").every(row => row.title_hash !== existing));
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  f.setRecords([]);
  s.changed(f.cwd);
  await rm(f.path);
  await s.query(f.request(""));
  assert.deepEqual(rows(f.cwd, "pix_session_titles"), []);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
});

test("one central configuration enables settings and explicit session titles together", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Private stored name", namedTitle: "Private stored name" }]);
  await f.preferences.configure();
  const s = f.make();
  const request = f.request("", { types: ["settings", "sessions"], settings: [setting] });
  await s.query(request);
  await f.idle(s);
  await s.index({ cwd: f.cwd, source: "sessions" });
  assert.equal(rows(f.cwd, "vectors").length, 1);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls), /Private stored name/);
});

test("revoking session-title consent cancels an uncooperative paid batch before persistence", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Named session", namedTitle: "Named session" }]);
  await f.preferences.configure();
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "Named session") { started.resolve(); await release.promise; }
    return inputs.map(vector);
  } });
  const pending = s.index({ cwd: f.cwd, source: "sessions" }).catch(error => error);
  await started.promise;
  await f.preferences.configure(false); await s.config({ cwd: f.cwd });
  release.resolve();
  await pending;
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
  assert.equal(rows(f.cwd, "pix_session_titles").length, 1, "local title mapping remains intact");
  assert.equal((await s.config({ cwd: f.cwd })).sessionTitlesEnabled, false);
});

test("title-change notification stops an in-flight old title from being indexed", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Previous name", namedTitle: "Previous name" }]);
  await f.preferences.configure();
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "Previous name") { started.resolve(); await release.promise; }
    return inputs.map(vector);
  } });
  const pending = s.index({ cwd: f.cwd, source: "sessions" });
  await started.promise;
  f.setRecords([{ ...f.record, title: "New name", namedTitle: "New name" }]);
  s.changed(f.cwd);
  release.resolve();
  await pending;
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), [], "old-title upload cannot persist after change");
  await s.index({ cwd: f.cwd, source: "sessions" });
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_titles").map(row => row.title), ["New name"]);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
});

test("session title indexing cannot replace commit data or incompatible paid vectors", async t => {
  const f = await fixture(t);
  const store = new SearchIndexStore();
  await store.write(f.cwd, signal(), () => Promise.resolve());
  await mkdir(join(f.cwd, ".pi/search"), { recursive: true });
  const db = new DatabaseSync(join(f.cwd, ".pi/search/git-commits.sqlite"));
  db.exec("CREATE TABLE pix_commit_vectors (hash TEXT PRIMARY KEY, vector TEXT NOT NULL)");
  db.prepare("INSERT INTO pix_commit_vectors VALUES (?,?)").run("commit-hash", "[1,0,0]");
  db.close();
  f.setRecords([{ ...f.record, title: "Named project", namedTitle: "Named project" }]);
  const s = f.make();
  await f.preferences.configure();
  // Establish metadata without buying vectors, then corrupt its identity.
  await store.write(f.cwd, signal(), async tx => { tx.sessionTitles(); }, await f.preferences.embedding(), { source: "sessions" });
  assert.equal(rows(f.cwd, "pix_commit_vectors").length, 1);
  const unsafe = new DatabaseSync(store.path(f.cwd, "sessions"));
  unsafe.prepare("UPDATE pix_session_meta SET value='unknown-model' WHERE key='model'").run();
  unsafe.close();
  await s.config({ cwd: f.cwd });
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), [], "incompatible identity fails closed");
  assert.equal(rows(f.cwd, "pix_session_meta").find(row => row.key === "model")?.value, "unknown-model");
  assert.equal(rows(f.cwd, "pix_commit_vectors").length, 1, "commit vectors must survive unrelated failures");
  assert.deepEqual(f.calls, [], "never pay before validating session-vector identity");
});

for (const change of ["delete", "rename"] as const) test(`mixed search revalidates session titles after provider failure and ${change}`, async t => {
  const f = await fixture(t); await f.preferences.configure();
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "модель") { started.resolve(); await release.promise; throw new Error("private provider failure"); }
    return inputs.map(vector);
  } });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await f.idle(s);
  const pending = s.query(f.request("модель", { types: ["settings", "sessions"], settings: [setting] }));
  await started.promise;
  f.setRecords(change === "delete" ? [] : [{ ...f.record, title: "Модель переименована" }]);
  if (change === "delete") await rm(f.path);
  else await f.publish("Модель переименована");
  release.resolve();
  const result = await pending;
  assert.deepEqual(result.results.filter(hit => hit.kind === "sessions").map(hit => hit.title),
    change === "delete" ? [] : ["Модель переименована"]);
  assert.match(result.status.error!, /Semantic settings search unavailable/);
});

for (const providerFails of [false, true]) test(`mixed search propagates controlled rediscovery failure after provider ${providerFails ? "failure" : "success"}`, async t => {
  const f = await fixture(t); await f.preferences.configure();
  let discoveries = 0;
  const s = f.make({
    sessionRecords: async () => { if (++discoveries > 1) throw new Error("private discovery failure"); return [f.record]; },
    embed: async inputs => {
      if (providerFails && inputs[0] === "модель") throw new Error("private provider failure");
      return inputs.map(vector);
    },
  });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await f.idle(s);
  await assert.rejects(s.query(f.request("модель", { types: ["settings", "sessions"], settings: [setting] })),
    /Session index metadata unavailable or timed out/);
  assert.equal(discoveries, 2);
});

test("OpenRouter short response model recovers settings indexing with canonical metadata", async t => {
  const f = await fixture(t); await f.preferences.configure(); let model = "wrong-model";
  f.setRecords([]);
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, EMBEDDING_ENDPOINT);
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, SEARCH_EMBEDDING_MODEL);
    return new Response(JSON.stringify({ object: "list", model, data: body.input.map((_: string, index: number) => ({ object: "embedding", index, embedding: vector() })) }));
  });
  const s = f.make({ embed: embedOpenRouter }); const request = f.request("", { types: ["settings"], settings: [setting] });
  await s.query(request); await f.idle(s);
  assert.match((await s.config({ cwd: f.cwd })).error!, /Semantic settings search unavailable/);
  assert.equal(rows(f.cwd, "vectors").length, 0);
  model = "pplx-embed-v1-0.6b"; await s.sync({ cwd: f.cwd, settings: [setting] }); await f.idle(s);
  assert.equal(rows(f.cwd, "vectors").length, 1);
  assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  assert.equal(rows(f.cwd, "metadata").find(row => row.key === "model")?.value, SEARCH_EMBEDDING_MODEL);
});

test("two services serialize the same settings batch without duplicate embeddings", async t => {
  const f = await fixture(t); await f.preferences.configure();
  const started = gate<void>(), release = gate<void>(); let calls = 0;
  const embed: Embedder = async inputs => { calls++; started.resolve(); await release.promise; return inputs.map(vector); };
  const a = f.make({ embed }), b = f.make({ embed });
  await Promise.all([a.config({ cwd: f.cwd }), b.config({ cwd: f.cwd })]);
  const request = f.request("", { types: ["settings"], settings: [setting] });
  await a.query(request); await started.promise; await b.query(request);
  release.resolve(); await Promise.all([f.idle(a), f.idle(b)]);
  assert.equal(calls, 1); assert.equal(rows(f.cwd, "vectors").length, 1);
});

test("consent revocation aborts an uncooperative settings provider without persisting stale vectors", async t => {
  const f = await fixture(t); await f.preferences.configure();
  const started = gate<void>(), release = gate<number[][]>(); let aborted = false;
  const s = f.make({ embed: async (_input, _key, owned) => { owned.addEventListener("abort", () => { aborted = true; }, { once: true }); started.resolve(); return release.promise; } });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await started.promise;
  await f.preferences.configure(false); await s.config({ cwd: f.cwd }); await f.idle(s);
  assert.equal(aborted, true); release.resolve([vector()]); await delay(10);
  assert.equal(rows(f.cwd, "vectors").length, 0);
});

test("discovery is bounded/cancelable, sanitizes errors, and never publishes stale completion", async t => {
  const f = await fixture(t); const source = gate<SessionMapRecord[]>(); let aborted = false;
  const s = f.make({ discoveryTimeoutMs: 30, sessionRecords: async (_cwd, owned) => { owned.addEventListener("abort", () => { aborted = true; }, { once: true }); return source.promise; } });
  await assert.rejects(s.query(f.request("модель")), /Session index metadata unavailable or timed out/);
  assert.equal(aborted, true); source.resolve([f.record]);
  const bad = f.make({ sessionRecords: async () => { throw new Error("Bearer SECRET private corpus"); } });
  await assert.rejects(bad.query(f.request("модель")), error => { assert.doesNotMatch(String(error), /SECRET|private/); return true; });
  const started = gate<void>();
  const blocked = f.make({ sessionRecords: async () => { started.resolve(); return new Promise(() => {}); } });
  const controller = new AbortController(); const query = blocked.query(f.request("модель"), controller.signal);
  await started.promise; controller.abort(); await assert.rejects(query); await blocked.dispose();
});

test("workspace switch and dispose cancel in-flight discovery before stale titles can escape", async t => {
  const f = await fixture(t); const started = gate<void>(), release = gate<SessionMapRecord[]>();
  const s = f.make({ sessionRecords: async () => { started.resolve(); return release.promise; } });
  const request = s.query(f.request("модель")); const canceled = assert.rejects(request); await started.promise;
  await s.config({ cwd: join(f.cwd, "other") }); await canceled;
  release.resolve([f.record]); await s.dispose();
  await assert.rejects(s.query(f.request("модель")), /Search unavailable/);
});

test("shared credential store preserves other providers and supports write-only key removal", async t => {
  const f = await fixture(t); const path = join(f.cwd, "auth.json");
  await writeFile(path, '{\n "anthropic": { "type": "api_key", "key": "other" }\n}');
  const auth = sharedSearchAuth(f.cwd, {}); await auth.save("sk-or-mock-only", signal());
  const contents = await readFile(path, "utf8"); assert.match(contents, /anthropic/);
  assert.equal(await auth.available(signal()), true); assert.equal(await auth.key(signal()), "sk-or-mock-only");
  await auth.save("", signal()); assert.equal(await auth.available(signal()), false);
});
