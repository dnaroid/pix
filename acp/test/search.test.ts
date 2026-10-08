import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopSearchService } from "../src/search/service.js";
import { SearchIndexStore, SearchIndexBusyError } from "../src/search/index-store.js";
import { SearchPreferences, sharedSearchAuth, type SearchAuth } from "../src/search/config.js";
import { SEARCH_EMBEDDING_MODEL, type SearchQueryRequest } from "../src/search/contract.js";
import { decodeEmbeddings, embedOpenRouter, EMBEDDING_DIMENSIONS, EMBEDDING_ENDPOINT, type Embedder } from "../src/search/embeddings.js";
import { hashText, settingsDocuments } from "../src/search/documents.js";
import { parseSearchQueryRequest, parseSearchConfigRequest } from "../src/search/request.js";
import type { SessionMapRecord } from "../src/acp/session-map.js";

const signal = () => new AbortController().signal;
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean | Promise<boolean>, message = "condition") {
  const end = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < end, `Timed out waiting for ${message}`); await delay(10); }
}
function rows(cwd: string, table: "documents" | "vectors" | "metadata" | "sqlite_master"
  | "pix_session_titles" | "pix_session_vectors" | "pix_session_meta" | "pix_commit_vectors") {
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(join(cwd, ".pi/search/index.sqlite"), { readOnly: true }); return db.prepare(`SELECT * FROM ${table}`).all(); }
  catch { return []; } finally { db?.close(); }
}
const setting = { id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: ["dark"] };
async function fixture(t: TestContext) {
  const artifacts = resolve(".pi/artifacts/session-title-search/fixtures");
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, "run-"));
  const path = join(cwd, "session.jsonl");
  const preferences = new SearchPreferences(join(cwd, "desktop.jsonc"));
  const record: SessionMapRecord = { sessionId: "s1", piSessionPath: path, piSessionId: "pi1", cwd, title: "Модель для эмбеддинга", updatedAt: new Date().toISOString() };
  let records = [record];
  let key: string | undefined = "mock-only";
  const auth: SearchAuth = { available: async () => Boolean(key), key: async () => key, save: async value => { key = value || undefined; } };
  const calls: string[][] = [];
  const embed: Embedder = async inputs => { calls.push([...inputs]); return inputs.map(vector); };
  const services: DesktopSearchService[] = [];
  const make = (overrides: Partial<ConstructorParameters<typeof DesktopSearchService>[0]> = {}) => {
    const service = new DesktopSearchService({ discover: async () => records, preferences, auth, embed, ...overrides });
    services.push(service); return service;
  };
  t.after(async () => { await Promise.all(services.map(s => s.dispose())); await rm(cwd, { recursive: true, force: true }); });
  const request = (query = "", extra = {}): SearchQueryRequest => ({ cwd, query, types: ["sessions"], settings: [], limit: 30, ...extra });
  const idle = async (s: DesktopSearchService) => until(async () => !(await s.config({ cwd })).indexing, "index idle");
  return { cwd, path, preferences, record, calls, make, request, idle,
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

test("session queries search only Unicode titles once per session, never body files or paid providers", async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true);
  const body = "{malformed JSONL but private bodyOnly data}";
  await writeFile(f.path, body);
  f.setRecords([f.record, f.record, { ...f.record, sessionId: "foreign", cwd: join(f.cwd, "other") },
    { ...f.record, sessionId: "empty", title: " " }]);
  const s = f.make();
  const hits = (await s.query(f.request("МОДЕЛЬ эмбеддинга"))).results;
  assert.deepEqual(hits.map(hit => hit.id), ["sessions:s1"]);
  assert.equal(hits[0]?.snippet, "");
  assert.equal("entryId" in hits[0]!, false);
  assert.deepEqual((await s.query(f.request("bodyOnly"))).results, []);
  assert.deepEqual((await s.query(f.request())).results, []);
  assert.deepEqual(f.calls, []);
  assert.equal(rows(f.cwd, "documents").length, 0);
  assert.equal(rows(f.cwd, "vectors").length, 0);
  assert.equal(await readFile(f.path, "utf8"), body);
});

test("explicit queries see title renames/deletions and missing body files without history scanning", async t => {
  const f = await fixture(t); const s = f.make();
  assert.equal((await s.query(f.request("модель"))).results.length, 1);
  f.setRecords([{ ...f.record, title: "Новый заголовок" }]); s.changed(f.cwd);
  assert.equal((await s.query(f.request("модель"))).results.length, 0);
  assert.equal((await s.query(f.request("заголовок"))).results.length, 1);
  f.setRecords([]);
  assert.equal((await s.query(f.request("заголовок"))).results.length, 0);
});

test("legacy migration clears only message documents/vectors/decisions, preserves settings and fences old writers", async t => {
  const f = await fixture(t);
  const store = new SearchIndexStore();
  const docs = settingsDocuments([setting]); const hash = hashText(docs[0]!.chunks[0]!);
  await store.write(f.cwd, signal(), tx => tx.save(docs, new Map([[hash, vector()]])));
  const db = new DatabaseSync(store.path(f.cwd));
  const bytes = Buffer.alloc(4096); bytes.writeFloatLE(1);
  db.exec("DROP TRIGGER settings_schema_insert; DROP TRIGGER settings_schema_update; DROP TRIGGER settings_document_insert; DROP TRIGGER settings_document_update; UPDATE metadata SET value='1' WHERE key='schema'; CREATE TABLE filter_decisions (hash TEXT PRIMARY KEY, decision TEXT NOT NULL)");
  db.prepare("INSERT INTO documents VALUES (?,?,?,?)").run("sessions:s1:u", "private message text", JSON.stringify({ kind: "sessions" }), JSON.stringify(["body-hash", hash]));
  db.prepare("INSERT INTO vectors VALUES (?,?)").run("body-hash", bytes);
  db.prepare("INSERT INTO filter_decisions VALUES (?,?)").run("body-hash", "KEEP"); db.close();
  await writeFile(f.path, "unchanged session contents");
  const s = f.make(); await s.config({ cwd: f.cwd, enabled: false });
  assert.deepEqual(rows(f.cwd, "documents").map(row => row.id), ["settings:theme"]);
  assert.deepEqual(rows(f.cwd, "vectors").map(row => row.hash), [hash]);
  assert.equal(rows(f.cwd, "sqlite_master").some(row => row.name === "filter_decisions"), false);
  assert.equal(rows(f.cwd, "metadata").find(row => row.key === "schema")?.value, "2");
  assert.equal(await readFile(f.path, "utf8"), "unchanged session contents");
  assert.deepEqual(f.calls, []);
  const oldWriter = new DatabaseSync(store.path(f.cwd));
  try {
    oldWriter.exec("BEGIN IMMEDIATE; DELETE FROM documents; DELETE FROM vectors");
    assert.throws(() => oldWriter.exec("INSERT OR REPLACE INTO metadata VALUES ('schema','1')"), /Search index requires session-title search/);
    oldWriter.exec("ROLLBACK");
    assert.throws(() => oldWriter.prepare("INSERT INTO documents VALUES (?,?,?,?)").run("sessions:stale", "private body", JSON.stringify({ kind: "sessions" }), "[]"), /Only settings may be indexed/);
  } finally { oldWriter.close(); }
  assert.equal(rows(f.cwd, "documents").length, 1);
  assert.equal(rows(f.cwd, "vectors").length, 1);
  await s.dispose(); await f.make().config({ cwd: f.cwd });
  assert.equal(rows(f.cwd, "documents").length, 1);
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

test("busy index does not prevent local titles and reports a controlled warning", async t => {
  const f = await fixture(t); const store = new SearchIndexStore(60);
  await store.write(f.cwd, signal(), async () => {});
  const db = new DatabaseSync(store.path(f.cwd)); db.exec("BEGIN IMMEDIATE");
  const s = f.make({ store });
  const writes = t.mock.method(store, "write");
  try {
    await assert.rejects(store.write(f.cwd, signal(), async () => {}), SearchIndexBusyError);
    const result = await s.query(f.request("модель"));
    assert.equal(result.results.length, 1); assert.match(result.status.error!, /index busy/);
    assert.match((await s.config({ cwd: f.cwd, enabled: false })).error!, /index busy/, "consent changes cannot hide pending migration");
  } finally { db.exec("ROLLBACK"); db.close(); }
  const attempts = writes.mock.callCount();
  assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  assert.equal(writes.mock.callCount(), attempts + 1, "status polling retries local migration after contention");
  await s.config({ cwd: f.cwd });
  assert.equal(writes.mock.callCount(), attempts + 1, "successful migration is not rerun on every poll");
  assert.deepEqual(f.calls, [], "migration retries never call providers");
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

test("settings embeddings persist/reuse across restart and never embed session titles/bodies", async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true);
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

test("separate session-title consent indexes named titles, not fallback prompts or history", async t => {
  const f = await fixture(t);
  const privateMessage = "PRIVATE-FIRST-MESSAGE-NOT-A-TITLE";
  await writeFile(f.path, `USER: ${privateMessage}\nPRIVATE-HISTORY-TEXT\n`);
  f.setRecords([
    { ...f.record, title: "Garden planning", namedTitle: "Garden planning" },
    { ...f.record, sessionId: "fallback", title: privateMessage },
    { ...f.record, sessionId: "mismatch", title: "Fresh rename", namedTitle: "Old name" },
  ]);
  const s = f.make();
  const before = await s.config({ cwd: f.cwd });
  assert.equal(before.sessionTitlesEnabled, false);
  await s.query(f.request("garden"));
  assert.deepEqual(f.calls, [], "session titles are never uploaded without separate consent");
  assert.deepEqual(rows(f.cwd, "pix_session_titles").map(row => row.session_id), ["s1"]);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
  assert.deepEqual(rows(f.cwd, "vectors"), []);

  await s.config({ cwd: f.cwd, sessionTitlesEnabled: true });
  await f.idle(s);
  assert.deepEqual(f.calls, [], "consent alone does not upload an earlier title snapshot");
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(f.calls, [["Garden planning"]], "only actual names may be embedded");
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE|Old name|эмбеддинга/);
  assert.equal(await readFile(f.path, "utf8"), `USER: ${privateMessage}\nPRIVATE-HISTORY-TEXT\n`);
  await s.dispose();

  const reopened = f.make();
  await reopened.query(f.request(""));
  await f.idle(reopened);
  assert.equal(f.calls.length, 1, "the durable vector must be reused after restart");
  await reopened.config({ cwd: f.cwd, sessionTitlesEnabled: false });
  const calls = f.calls.length;
  await reopened.query(f.request("garden"));
  assert.equal(f.calls.length, calls, "revocation keeps the lexical search local");
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1, "revocation retains the paid local cache");
});

test("session-title embeddings add non-lexical results without affecting settings or commits", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Orchard maintenance", namedTitle: "Orchard maintenance" }]);
  await f.preferences.setSessionTitlesEnabled(true);
  const s = f.make();
  await s.query(f.request(""));
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
  await f.preferences.setSessionTitlesEnabled(true);
  f.setRecords([
    { ...f.record, title: "Historic overview", namedTitle: "Historic overview" },
    { ...f.record, sessionId: "s2", title: "Historic overview", namedTitle: "Historic overview" },
  ]);
  const s = f.make();
  await s.query(f.request(""));
  await f.idle(s);
  assert.equal(rows(f.cwd, "pix_session_titles").length, 2);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1, "same title shares a single embedding");
  const existing = rows(f.cwd, "pix_session_vectors")[0]!.title_hash;
  f.setRecords([{ ...f.record, sessionId: "s2", title: "New topic", namedTitle: "New topic" }]);
  s.changed(f.cwd);
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_titles").map(row => row.session_id), ["s2"]);
  assert.ok(rows(f.cwd, "pix_session_vectors").every(row => row.title_hash !== existing));
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
  f.setRecords([]);
  s.changed(f.cwd);
  await s.query(f.request(""));
  assert.deepEqual(rows(f.cwd, "pix_session_titles"), []);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
});

test("settings consent never grants session-title embedding consent", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Private stored name", namedTitle: "Private stored name" }]);
  await f.preferences.setEnabled(true);
  const s = f.make();
  const request = f.request("", { types: ["settings", "sessions"], settings: [setting] });
  await s.query(request);
  await f.idle(s);
  assert.equal(rows(f.cwd, "vectors").length, 1);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 0);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /Private stored name/);
});

test("revoking session-title consent cancels an uncooperative paid batch before persistence", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Named session", namedTitle: "Named session" }]);
  await f.preferences.setSessionTitlesEnabled(true);
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "Named session") { started.resolve(); await release.promise; }
    return inputs.map(vector);
  } });
  await s.query(f.request(""));
  await started.promise;
  await s.config({ cwd: f.cwd, sessionTitlesEnabled: false });
  release.resolve();
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), []);
  assert.equal(rows(f.cwd, "pix_session_titles").length, 1, "local title mapping remains intact");
  assert.equal((await s.config({ cwd: f.cwd })).sessionTitlesEnabled, false);
});

test("title-change notification stops an in-flight old title from being indexed", async t => {
  const f = await fixture(t);
  f.setRecords([{ ...f.record, title: "Previous name", namedTitle: "Previous name" }]);
  await f.preferences.setSessionTitlesEnabled(true);
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "Previous name") { started.resolve(); await release.promise; }
    return inputs.map(vector);
  } });
  await s.query(f.request(""));
  await started.promise;
  f.setRecords([{ ...f.record, title: "New name", namedTitle: "New name" }]);
  s.changed(f.cwd);
  release.resolve();
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), [], "old-title upload cannot persist after change");
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_titles").map(row => row.title), ["New name"]);
  assert.equal(rows(f.cwd, "pix_session_vectors").length, 1);
});

test("session title indexing cannot replace commit data or incompatible paid vectors", async t => {
  const f = await fixture(t);
  const store = new SearchIndexStore();
  await store.write(f.cwd, signal(), () => Promise.resolve());
  const db = new DatabaseSync(store.path(f.cwd));
  db.exec("CREATE TABLE pix_commit_vectors (hash TEXT PRIMARY KEY, vector TEXT NOT NULL)");
  db.prepare("INSERT INTO pix_commit_vectors VALUES (?,?)").run("commit-hash", "[1,0,0]");
  db.close();
  f.setRecords([{ ...f.record, title: "Named project", namedTitle: "Named project" }]);
  const s = f.make();
  await s.query(f.request(""));
  assert.equal(rows(f.cwd, "pix_commit_vectors").length, 1);
  const unsafe = new DatabaseSync(store.path(f.cwd));
  unsafe.prepare("UPDATE pix_session_meta SET value='unknown-model' WHERE key='model'").run();
  unsafe.close();
  await s.config({ cwd: f.cwd, sessionTitlesEnabled: true });
  await s.query(f.request(""));
  await f.idle(s);
  assert.deepEqual(rows(f.cwd, "pix_session_vectors"), [], "incompatible identity fails closed");
  assert.equal(rows(f.cwd, "pix_session_meta").find(row => row.key === "model")?.value, "unknown-model");
  assert.equal(rows(f.cwd, "pix_commit_vectors").length, 1, "commit vectors must survive unrelated failures");
  assert.deepEqual(f.calls, [], "never pay before validating session-vector identity");
});

for (const change of ["delete", "rename"] as const) test(`mixed search revalidates session titles after provider failure and ${change}`, async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true);
  const started = gate<void>(), release = gate<void>();
  const s = f.make({ embed: async inputs => {
    if (inputs[0] === "модель") { started.resolve(); await release.promise; throw new Error("private provider failure"); }
    return inputs.map(vector);
  } });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await f.idle(s);
  const pending = s.query(f.request("модель", { types: ["settings", "sessions"], settings: [setting] }));
  await started.promise;
  f.setRecords(change === "delete" ? [] : [{ ...f.record, title: "Модель переименована" }]);
  release.resolve();
  const result = await pending;
  assert.deepEqual(result.results.filter(hit => hit.kind === "sessions").map(hit => hit.title),
    change === "delete" ? [] : ["Модель переименована"]);
  assert.match(result.status.error!, /Semantic settings search unavailable/);
});

for (const providerFails of [false, true]) test(`mixed search propagates controlled rediscovery failure after provider ${providerFails ? "failure" : "success"}`, async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true);
  let discoveries = 0;
  const s = f.make({
    discover: async () => { if (++discoveries > 1) throw new Error("private discovery failure"); return [f.record]; },
    embed: async inputs => {
      if (providerFails && inputs[0] === "модель") throw new Error("private provider failure");
      return inputs.map(vector);
    },
  });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await f.idle(s);
  await assert.rejects(s.query(f.request("модель", { types: ["settings", "sessions"], settings: [setting] })),
    /Session title discovery timed out or failed/);
  assert.equal(discoveries, 2);
});

test("OpenRouter short response model recovers settings indexing with canonical metadata", async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true); let model = "wrong-model";
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, EMBEDDING_ENDPOINT);
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, SEARCH_EMBEDDING_MODEL);
    return new Response(JSON.stringify({ object: "list", model, data: body.input.map((_: string, index: number) => ({ object: "embedding", index, embedding: vector() })) }));
  });
  const s = f.make({ embed: embedOpenRouter }); const request = f.request("", { types: ["settings"], settings: [setting] });
  await s.query(request); await f.idle(s);
  assert.match((await s.config({ cwd: f.cwd })).error!, /Semantic settings search unavailable/);
  assert.equal(rows(f.cwd, "vectors").length, 0);
  model = "pplx-embed-v1-0.6b"; await s.query(request); await f.idle(s);
  assert.equal(rows(f.cwd, "vectors").length, 1);
  assert.equal((await s.config({ cwd: f.cwd })).error, undefined);
  assert.equal(rows(f.cwd, "metadata").find(row => row.key === "model")?.value, SEARCH_EMBEDDING_MODEL);
});

test("two services serialize the same settings batch without duplicate embeddings", async t => {
  const f = await fixture(t); await f.preferences.setEnabled(true);
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
  const f = await fixture(t); await f.preferences.setEnabled(true);
  const started = gate<void>(), release = gate<number[][]>(); let aborted = false;
  const s = f.make({ embed: async (_input, _key, owned) => { owned.addEventListener("abort", () => { aborted = true; }, { once: true }); started.resolve(); return release.promise; } });
  await s.query(f.request("", { types: ["settings"], settings: [setting] })); await started.promise;
  await s.config({ cwd: f.cwd, enabled: false }); await f.idle(s);
  assert.equal(aborted, true); release.resolve([vector()]); await delay(10);
  assert.equal(rows(f.cwd, "vectors").length, 0);
});

test("discovery is bounded/cancelable, sanitizes errors, and never publishes stale completion", async t => {
  const f = await fixture(t); const source = gate<SessionMapRecord[]>(); let aborted = false;
  const s = f.make({ discoveryTimeoutMs: 30, discover: async (_cwd, owned) => { owned.addEventListener("abort", () => { aborted = true; }, { once: true }); return source.promise; } });
  await assert.rejects(s.query(f.request("модель")), /Session title discovery timed out or failed/);
  assert.equal(aborted, true); source.resolve([f.record]);
  const bad = f.make({ discover: async () => { throw new Error("Bearer SECRET private corpus"); } });
  await assert.rejects(bad.query(f.request("модель")), error => { assert.doesNotMatch(String(error), /SECRET|private/); return true; });
  const started = gate<void>();
  const blocked = f.make({ discover: async () => { started.resolve(); return new Promise(() => {}); } });
  const controller = new AbortController(); const query = blocked.query(f.request("модель"), controller.signal);
  await started.promise; controller.abort(); await assert.rejects(query); await blocked.dispose();
});

test("workspace switch and dispose cancel in-flight discovery before stale titles can escape", async t => {
  const f = await fixture(t); const started = gate<void>(), release = gate<SessionMapRecord[]>();
  const s = f.make({ discover: async () => { started.resolve(); return release.promise; } });
  const request = s.query(f.request("модель")); const canceled = assert.rejects(request); await started.promise;
  await s.config({ cwd: join(f.cwd, "other") }); await canceled;
  release.resolve([f.record]); await s.dispose();
  await assert.rejects(s.query(f.request("модель")), /Search unavailable/);
});

test("shared credential store preserves other providers and supports write-only key removal", async t => {
  const f = await fixture(t); const path = join(f.cwd, "auth.json");
  await writeFile(path, '{\n "anthropic": { "type": "api_key", "key": "other" }\n}');
  const auth = sharedSearchAuth(f.cwd); await auth.save("sk-or-mock-only", signal());
  const contents = await readFile(path, "utf8"); assert.match(contents, /anthropic/);
  assert.equal(await auth.available(signal()), true); assert.equal(await auth.key(signal()), "sk-or-mock-only");
  await auth.save("", signal()); assert.equal(await auth.available(signal()), false);
});
