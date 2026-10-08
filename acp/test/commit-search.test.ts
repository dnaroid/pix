import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopCommitSearchService, type CommitSearchOptions } from "../src/search/commit-service.js";
import { parseCommitSearchRequest } from "../src/search/commit-contract.js";
import { embedCommitHTTP, embeddingIdentity, loadCommitEmbeddingConfig, loadCommitEmbeddingKey, type CommitEmbeddingConfig, type CommitEmbedder } from "../src/search/commit-provider.js";
import { rankCommits, readCommitCorpus, type CommitDocument } from "../src/search/commit-corpus.js";
import { canonicalSearchIndexPath } from "../src/search/canonical-index.js";
import { COMMIT_DOCUMENTS, COMMIT_META, COMMIT_VECTORS } from "../src/search/commit-storage.js";

const exec = promisify(execFile);
const config: CommitEmbeddingConfig = { provider: "openrouter", model: "test/model", dimension: 3, queryPrefix: "Q:", documentPrefix: "D:", baseUrl: "https://openrouter.ai/api/v1" };
const signal = () => new AbortController().signal;
const options = (embed: CommitEmbedder = async texts => texts.map(() => [1, 0, 0])) => ({ loadConfig: async () => config, loadKey: async () => "mock-key", embed });
async function repository(t: { after: (fn: () => Promise<void>) => void }) {
  const base = fileURLToPath(new URL("../../.pi/artifacts/commit-hybrid-backend/", import.meta.url)); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "fixture-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const pending = exec("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Test Author", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test Author", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
    pending.child.stdin?.end(); return (await pending).stdout.trim();
  };
  await git("init", "-q");
  const tree = await git("mktree"); let head: string | undefined;
  const commit = async (message: string, parent = head) => {
    const hash = await git("commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message);
    await git("update-ref", "HEAD", hash); head = hash; return hash;
  };
  return { cwd, git, commit };
}
function service(t: { after: (fn: () => Promise<void>) => void }, opts: CommitSearchOptions = options()) {
  const s = new DesktopCommitSearchService(opts); t.after(() => s.dispose()); return s;
}
const query = (s: DesktopCommitSearchService, cwd: string, text = "target") => s.query({ cwd, query: text, limit: 20 }, signal());
function snapshot(cwd: string) {
  const db = new DatabaseSync(canonicalSearchIndexPath(cwd));
  try { return { identity: db.prepare(`SELECT value FROM ${COMMIT_META} WHERE key='identity'`).get()?.value, vectors: db.prepare(`SELECT * FROM ${COMMIT_VECTORS} ORDER BY hash`).all() }; }
  finally { db.close(); }
}
function gate() {
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(r => { release = r; }); const start = new Promise<void>(r => { entered = r; });
  return { release, entered, wait, start };
}

test("strict allowlisted request parsing", () => {
  assert.deepEqual(parseCommitSearchRequest({ cwd: "/tmp/project", query: "word", secret: "discard" }), { cwd: "/tmp/project", query: "word", limit: 20 });
  for (const value of [null, [], { cwd: "relative", query: "x" }, { cwd: "/tmp\0", query: "x" }, { cwd: "/tmp", query: "x".repeat(2049) }, { cwd: "/tmp", query: "x", limit: 0 }, { cwd: "/tmp", query: "x", limit: 1.5 }, { cwd: "/tmp", query: "x", limit: 101 }]) assert.throws(() => parseCommitSearchRequest(value), e => typeof e === "object" && e !== null && "code" in e && e.code === -32602);
});
test("enumerates beyond 30, full messages, authors and hash prefixes; excludes unrelated branches", async t => {
  const r = await repository(t); const first = await r.commit("ancient target\n\nveryoldbodytoken");
  for (let i = 0; i < 36; i++) await r.commit(`routine ${i}`);
  const head = await r.git("rev-parse", "HEAD"); const unrelated = await r.commit("unrelated target", "");
  await r.git("branch", "other", unrelated); await r.git("update-ref", "HEAD", head);
  const s = service(t, { ...options(), loadConfig: async () => undefined });
  const bodyHit = (await query(s, r.cwd, "veryoldbodytoken")).results[0];
  assert.equal(bodyHit?.hash, first);
  assert.equal(bodyHit?.id, `commits:${first}`);
  assert.equal(bodyHit?.contentMatch, true);
  assert.ok(!bodyHit?.snippet.includes("veryoldbodytoken"));
  assert.equal((await query(s, r.cwd, first.slice(0, 9))).results[0]?.hash, first);
  assert.ok((await query(s, r.cwd, "Test Author")).results.length > 0);
  assert.ok(!(await query(s, r.cwd, "unrelated")).results.length);
});
test("semantic-only candidate has no literal query terms", async t => {
  const r = await repository(t); const hash = await r.commit("repair orchard irrigation");
  const s = service(t, options(async texts => texts.map(() => [0, 1, 0])));
  const result = await query(s, r.cwd, "agricultural hydration");
  assert.equal(result.results[0]?.hash, hash); assert.equal(result.results[0]?.semantic, true); assert.deepEqual(result.notices, []);
});
test("restart reuses document vectors; incremental commit embeds only addition", async t => {
  const r = await repository(t); await r.commit("old target"); let docs = 0, queries = 0;
  const opts = options(async texts => { if (texts[0]!.startsWith("Q:")) queries++; else docs += texts.length; return texts.map(() => [1, 0, 0]); });
  const a = service(t, opts); await query(a, r.cwd); await a.dispose();
  const b = service(t, opts); await query(b, r.cwd); assert.equal(docs, 1); assert.equal(queries, 2);
  await r.commit("new target"); await query(b, r.cwd); assert.equal(docs, 2); assert.equal(queries, 2);
  assert.equal(snapshot(r.cwd).vectors.length, 2);
});
test("imports a legacy commit index into canonical SQLite without paying again or changing either source database", async t => {
  const r = await repository(t);
  await r.commit("target from legacy");
  const [doc] = await readCommitCorpus(r.cwd, signal());
  assert.ok(doc);
  const directory = join(r.cwd, ".pi", "search");
  await mkdir(directory, { recursive: true });
  const oldPath = join(directory, "commits.sqlite");
  const old = new DatabaseSync(oldPath);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE vectors (hash TEXT PRIMARY KEY, vector TEXT NOT NULL); CREATE TABLE commits (hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL, metadata TEXT NOT NULL, message TEXT NOT NULL)");
  old.prepare("INSERT INTO meta VALUES ('identity', ?)").run(embeddingIdentity(config));
  old.prepare("INSERT INTO vectors VALUES (?, ?)").run(doc.contentHash, JSON.stringify([1, 0, 0]));
  old.prepare("INSERT INTO commits VALUES (?, ?, ?, ?)").run(doc.commit.hash, doc.contentHash, JSON.stringify(doc.commit), doc.message);
  old.close();
  const oldBytes = await readFile(oldPath);

  // A pre-existing settings schema, with its own vector representation,
  // must survive migration unmodified (same SQLite file, separate tables).
  const canonical = new DatabaseSync(canonicalSearchIndexPath(r.cwd));
  canonical.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE documents (id TEXT PRIMARY KEY, text TEXT, hit TEXT, hashes TEXT); CREATE TABLE vectors (hash TEXT PRIMARY KEY, vector BLOB NOT NULL)");
  canonical.prepare("INSERT INTO vectors VALUES ('settings-hash', ?)").run(Buffer.from([12, 34, 56]));
  canonical.close();
  let docs = 0, queries = 0;
  const opts = options(async inputs => {
    if (inputs[0]?.startsWith("D:")) docs += inputs.length;
    else queries += inputs.length;
    return inputs.map(() => [1, 0, 0]);
  });
  const s = service(t, opts);
  const found = await query(s, r.cwd);
  assert.equal(found.results[0]?.hash, doc.commit.hash);
  assert.equal(docs, 0, "the existing vector must not trigger paid re-embedding");
  assert.equal(queries, 1);
  assert.deepEqual(snapshot(r.cwd).vectors.map(row => row.hash), [doc.contentHash]);
  const shared = new DatabaseSync(canonicalSearchIndexPath(r.cwd), { readOnly: true });
  assert.deepEqual([...shared.prepare("SELECT vector FROM vectors WHERE hash='settings-hash'").get()!.vector as Uint8Array], [12, 34, 56]);
  assert.equal(shared.prepare(`SELECT COUNT(*) n FROM ${COMMIT_DOCUMENTS}`).get()!.n, 1);
  shared.close();
  assert.deepEqual(await readFile(oldPath), oldBytes, "legacy database is retained byte-for-byte");
  await query(s, r.cwd);
  assert.equal(docs, 0, "the next invocation reuses the migrated vector");
});

test("legacy vector migration never mixes incompatible embedding models", async t => {
  const r = await repository(t); await r.commit("target");
  const [doc] = await readCommitCorpus(r.cwd, signal());
  assert.ok(doc);
  await mkdir(join(r.cwd, ".pi/search"), { recursive: true });
  const path = join(r.cwd, ".pi/search/commits.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE vectors (hash TEXT PRIMARY KEY, vector TEXT NOT NULL); CREATE TABLE commits (hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL, metadata TEXT NOT NULL, message TEXT NOT NULL)");
  old.prepare("INSERT INTO meta VALUES ('identity', ?)").run(embeddingIdentity({ ...config, model: "unrelated" }));
  old.prepare("INSERT INTO vectors VALUES (?, ?)").run(doc.contentHash, JSON.stringify([1, 0, 0]));
  old.close();
  const canonical = new DatabaseSync(canonicalSearchIndexPath(r.cwd));
  canonical.exec(`CREATE TABLE ${COMMIT_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ${COMMIT_VECTORS} (hash TEXT PRIMARY KEY, vector TEXT NOT NULL); CREATE TABLE ${COMMIT_DOCUMENTS} (hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL, metadata TEXT NOT NULL, message TEXT NOT NULL)`);
  canonical.prepare(`INSERT INTO ${COMMIT_META} VALUES ('identity', ?)`).run(embeddingIdentity(config));
  canonical.close();
  let embedded = 0;
  await query(service(t, options(async inputs => { if (inputs[0]!.startsWith("D:")) embedded++; return inputs.map(() => [1, 0, 0]); })), r.cwd);
  assert.equal(embedded, 1, "an incompatible old vector must not be reused");
  assert.equal(snapshot(r.cwd).identity, embeddingIdentity(config));
});
test("canonical commit namespace leaves future IDX table names untouched", async t => {
  const r = await repository(t); await r.commit("target");
  await mkdir(join(r.cwd, ".pi/search"), { recursive: true });
  const db = new DatabaseSync(canonicalSearchIndexPath(r.cwd));
  // These stand-ins only reserve IDX's existing table names; they do not
  // require sqlite-vec or change a real IDX project.
  db.exec("CREATE TABLE vec_chunks (marker TEXT NOT NULL); CREATE TABLE vector_meta (marker TEXT NOT NULL); CREATE TABLE snapshots (id TEXT PRIMARY KEY); INSERT INTO vec_chunks VALUES ('preserve'); INSERT INTO vector_meta VALUES ('preserve'); INSERT INTO snapshots VALUES ('preserve');");
  db.close();
  await query(service(t), r.cwd);
  const verify = new DatabaseSync(canonicalSearchIndexPath(r.cwd), { readOnly: true });
  try {
    assert.equal(verify.prepare("SELECT marker FROM vec_chunks").get()?.marker, "preserve");
    assert.equal(verify.prepare("SELECT marker FROM vector_meta").get()?.marker, "preserve");
    assert.equal(verify.prepare("SELECT id FROM snapshots").get()?.id, "preserve");
    assert.equal(verify.prepare(`SELECT COUNT(*) n FROM ${COMMIT_VECTORS}`).get()?.n, 1);
  } finally { verify.close(); }
});
test("rewritten unreachable history excluded from lexical and semantic results", async t => {
  const r = await repository(t); const old = await r.commit("obsolete target"); const s = service(t);
  await query(s, r.cwd); const newer = await r.commit("replacement target", "");
  const result = await query(s, r.cwd); assert.deepEqual(result.results.map(h => h.hash), [newer]); assert.notEqual(newer, old);
});
test("missing config/key and unsupported provider retain lexical results and existing DB", async t => {
  const r = await repository(t); await r.commit("target"); await query(service(t), r.cwd); const before = snapshot(r.cwd);
  for (const opts of [{ ...options(), loadConfig: async () => undefined }, { ...options(), loadKey: async () => undefined }]) {
    const response = await query(service(t, opts), r.cwd); assert.equal(response.results.length, 1); assert.equal(response.results[0]?.semantic, undefined); assert.equal(response.notices.length, 1);
    assert.deepEqual(snapshot(r.cwd), before);
  }
  await mkdir(join(r.cwd, ".indexer-cli")); await writeFile(join(r.cwd, ".indexer-cli/config.json"), JSON.stringify({ embeddingProvider: "unsupported", embeddingModel: "x", vectorSize: 3 }));
  assert.equal(await loadCommitEmbeddingConfig(r.cwd), undefined);
});
test("model/dimension/prefix identity changes rebuild without mixed vectors", async t => {
  const r = await repository(t); await r.commit("target"); await query(service(t), r.cwd);
  const changed = { ...config, model: "test/new", dimension: 2, queryPrefix: "question:" }; let count = 0;
  const s = service(t, { ...options(async texts => { count += texts.length; return texts.map(() => [0, 1]); }), loadConfig: async () => changed });
  assert.deepEqual((await query(s, r.cwd)).notices, []); assert.equal(count, 2);
  const snap = snapshot(r.cwd); assert.equal(snap.identity, embeddingIdentity(changed)); assert.ok(snap.vectors.every(v => JSON.parse(String(v.vector)).length === 2));
});
test("incompatible config failure preserves prior index", async t => {
  const r = await repository(t); await r.commit("target"); await query(service(t), r.cwd); const before = snapshot(r.cwd);
  const s = service(t, { ...options(async () => { throw new Error("SECRET provider body"); }), loadConfig: async () => ({ ...config, model: "different" }) });
  const response = await query(s, r.cwd); assert.equal(response.results.length, 1); assert.ok(!JSON.stringify(response).includes("SECRET")); assert.deepEqual(snapshot(r.cwd), before);
});
test("two services acquire SQLite ownership before paid batches", async t => {
  const r = await repository(t); await r.commit("target"); let docs = 0;
  const g = gate();
  const opts = options(async texts => { if (texts[0]!.startsWith("D:")) { docs += texts.length; g.entered(); await g.wait; } return texts.map(() => [1, 0, 0]); });
  const a = service(t, opts), b = service(t, opts); const qa = query(a, r.cwd); await g.start;
  const qb = query(b, r.cwd); await new Promise(r => setTimeout(r, 100)); assert.equal(docs, 1); g.release();
  assert.equal((await qa).results.length, 1); assert.equal((await qb).results.length, 1); assert.equal(docs, 1);
});
test("separate processes cannot duplicate paid document batches", async t => {
  const r = await repository(t); await r.commit("target"); const payment = join(r.cwd, "mock-payment-count");
  const source = `import { DesktopCommitSearchService } from ${JSON.stringify(new URL("../src/search/commit-service.ts", import.meta.url).href)};
    import {appendFile} from 'node:fs/promises';
    const service = new DesktopCommitSearchService({loadConfig: async()=>(${JSON.stringify(config)}), loadKey:async()=> 'mock',
      embed:async texts=>{if(texts[0].startsWith('D:')) {await appendFile(process.argv[2], 'document\\n');await new Promise(r=>setTimeout(r,250));}return texts.map(()=>[1,0,0]);}});
    const result=await service.query({cwd:process.argv[1],query:'target',limit:20},new AbortController().signal);
    await service.dispose(); if(result.results.length!==1||result.notices.length)process.exitCode=1;`;
  const run = () => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, r.cwd, payment], { timeout: 15000 });
  const first = run();
  for (let i = 0; i < 500; i++) {
    if (await readFile(payment, "utf8").then(() => true, () => false)) break;
    await new Promise(r => setTimeout(r, 10));
  }
  const second = run(); await Promise.all([first, second]);
  assert.equal(await readFile(payment, "utf8"), "document\n"); assert.equal(snapshot(r.cwd).vectors.length, 1);
});
test("bounded SQLite contention gives lexical fallback without deleting lock/index", async t => {
  const r = await repository(t); await r.commit("target"); await query(service(t), r.cwd); const before = snapshot(r.cwd);
  const db = new DatabaseSync(canonicalSearchIndexPath(r.cwd)); db.exec("BEGIN IMMEDIATE");
  try { const result = await query(service(t, { ...options(), lockWaitMs: 50 }), r.cwd); assert.equal(result.results.length, 1); assert.match(result.notices[0]!, /busy/); }
  finally { db.exec("ROLLBACK"); db.close(); }
  assert.deepEqual(snapshot(r.cwd), before);
});
test("redirected legacy and canonical commit-index paths and sidecars cannot redirect writes", async t => {
  for (const kind of ["directory", "legacy-database", "legacy-wal", "legacy-shm", "legacy-journal", "canonical-database", "canonical-wal", "canonical-shm", "canonical-journal"]) {
    const r = await repository(t); await r.commit("protected history");
    const outside = await repository(t);
    const protectedFile = join(outside.cwd, "commits.sqlite");
    const db = new DatabaseSync(protectedFile);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged')"); db.close();
    const before = await readFile(protectedFile);
    await mkdir(join(r.cwd, ".pi"));
    if (kind === "directory") await symlink(outside.cwd, join(r.cwd, ".pi", "search"));
    else {
      await mkdir(join(r.cwd, ".pi", "search"));
      const [location, part] = kind.split("-");
      const suffix = part === "database" ? "" : `-${part}`;
      const filename = location === "canonical" ? "index.sqlite" : "commits.sqlite";
      await symlink(protectedFile, join(r.cwd, ".pi", "search", `${filename}${suffix}`));
    }
    let calls = 0;
    const s = service(t, options(async texts => { calls++; return texts.map(() => [1, 0, 0]); }));
    const result = await query(s, r.cwd, "protected");
    assert.equal(result.results.length, 1); assert.match(result.notices.join(" "), /unavailable/);
    assert.equal(calls, 0); assert.deepEqual(await readFile(protectedFile), before);
    await s.dispose();
  }
});
test("abort retains committed batches and ignores late embed completion", async t => {
  const r = await repository(t); for (let i = 0; i < 20; i++) await r.commit(`target ${i}`);
  const g = gate(); let batch = 0;
  const s = service(t, options(async texts => { if (++batch === 2) { g.entered(); await g.wait; } return texts.map(() => [1, 0, 0]); }));
  const c = new AbortController(); const p = s.query({ cwd: r.cwd, query: "target", limit: 20 }, c.signal); const rejected = assert.rejects(p);
  await g.start; c.abort(); g.release(); await rejected;
  assert.equal(snapshot(r.cwd).vectors.length, 16);
});
test("provider failure retains earlier successful batches for resume", async t => {
  const r = await repository(t); for (let i = 0; i < 20; i++) await r.commit(`target ${i}`); let calls = 0;
  const a = service(t, options(async texts => { if (++calls === 2) throw new Error("SECRET_PROVIDER_BODY"); return texts.map(() => [1, 0, 0]); }));
  const response = await query(a, r.cwd); assert.equal(response.results.length, 20); assert.ok(!JSON.stringify(response).includes("SECRET")); assert.equal(snapshot(r.cwd).vectors.length, 16);
  let resumed = 0; const b = service(t, options(async texts => { if (texts[0]!.startsWith("D:")) resumed += texts.length; return texts.map(() => [1, 0, 0]); }));
  await query(b, r.cwd); assert.equal(resumed, 4); assert.equal(snapshot(r.cwd).vectors.length, 20);
});
test("changed and dispose cancel and wait for actual transport unwinding", async t => {
  for (const mode of ["changed", "dispose"]) {
    const r = await repository(t); await r.commit("target"); const g = gate();
    const s = service(t, options(async texts => { g.entered(); await g.wait; return texts.map(() => [1, 0, 0]); }));
    const pending = query(s, r.cwd); const rejected = assert.rejects(pending); await g.start;
    let finished = false; const disposal = mode === "dispose" ? s.dispose().then(() => { finished = true; }) : (s.changed(r.cwd), Promise.resolve());
    await new Promise(r => setTimeout(r, 30)); if (mode === "dispose") assert.equal(finished, false);
    g.release(); await rejected; await disposal; assert.equal(snapshot(r.cwd).vectors.length, 0);
  }
});
test("config changing mid-batch cannot publish stale identity", async t => {
  const r = await repository(t); await r.commit("target"); let current = config; const g = gate();
  const s = service(t, { ...options(async texts => { g.entered(); await g.wait; return texts.map(() => [1, 0, 0]); }), loadConfig: async () => current });
  const pending = query(s, r.cwd); await g.start; current = { ...config, model: "changed" }; g.release();
  const result = await pending; assert.equal(result.results.length, 1); assert.equal(result.notices.length, 1); assert.equal(snapshot(r.cwd).identity, undefined); assert.equal(snapshot(r.cwd).vectors.length, 0);
});
test("malformed/nonfinite/zero/wrong-dimensional vectors never enter DB", async t => {
  for (const vector of [[NaN, 0, 0], [Infinity, 0, 0], [0, 0, 0], [1, 0], [1e300, 0, 0]]) {
    const r = await repository(t); await r.commit("target");
    const s = service(t, options(async texts => texts.map(() => vector)));
    const result = await query(s, r.cwd); assert.equal(result.results.length, 1); assert.equal(result.notices.length, 1); assert.equal(snapshot(r.cwd).vectors.length, 0);
  }
});
test("BM25 term saturation, length normalization, rare-term ranking and stable ties", () => {
  const doc = (hash: string, message: string): CommitDocument => ({ commit: { hash, shortHash: hash.slice(0, 8), subject: "", author: "", date: "" }, message, contentHash: hash });
  const docs = [doc("a", "target target"), doc("b", "target " + "noise ".repeat(100)), doc("c", "rare target"), doc("d", "rare target")];
  const result = rankCommits(docs, "rare target", 20, new Map());
  assert.deepEqual(result.slice(0, 2).map(h => h.hash), ["c", "d"]);
  assert.ok(result.findIndex(h => h.hash === "a") < result.findIndex(h => h.hash === "b"));
});
test("nonrepository, unborn repository, empty query and disposed service are safe", async t => {
  const r = await repository(t); const s = service(t);
  assert.deepEqual(await query(s, r.cwd, " "), { results: [], notices: [] });
  assert.equal((await query(s, r.cwd)).notices.length, 1);
  await mkdir(join(r.cwd, "notrepo")); assert.equal((await query(s, "/not/a/repository")).notices.length, 1);
  await s.dispose(); await assert.rejects(query(s, r.cwd));
});
test("saved IDX knowledge model/prefix/base URL and ENV/dotenv precedence", async t => {
  const r = await repository(t); await mkdir(join(r.cwd, ".indexer-cli"));
  const file = join(r.cwd, ".indexer-cli/config.json");
  await writeFile(file, JSON.stringify({ embeddingProvider: "ollama", embeddingModel: "code-model", knowledgeEmbeddingModel: "knowledge-model", vectorSize: 4, knowledgeEmbeddingQueryPrefix: "query:", knowledgeEmbeddingDocumentPrefix: "doc:", ollamaBaseUrl: "http://localhost:11434" }));
  assert.deepEqual(await loadCommitEmbeddingConfig(r.cwd), { provider: "ollama", model: "knowledge-model", dimension: 4, queryPrefix: "query:", documentPrefix: "doc:", baseUrl: "http://localhost:11434" });
  await mkdir(join(r.cwd, ".config/idx"), { recursive: true }); await writeFile(join(r.cwd, ".config/idx/.env"), "OPENROUTER_API_KEY=mock-dotenv\n");
  assert.equal(await loadCommitEmbeddingKey({ OPENROUTER_API_KEY: " mock-env " }, r.cwd), "mock-env");
  assert.equal(await loadCommitEmbeddingKey({}, r.cwd), "mock-dotenv");
  assert.equal(await loadCommitEmbeddingKey({}, join(r.cwd, "missing-home")), undefined);
  const contents = await readFile(file, "utf8"); assert.ok(!contents.includes("mock-env"));
});
test("HTTP model alias, vector validation, cancellation and secret-body redaction", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const payload = (model: string, embedding: unknown) => ({ object: "list", model, data: [{ object: "embedding", index: 0, embedding }] });
  globalThis.fetch = async () => Response.json(payload("model", [1, 0, 0]));
  assert.deepEqual(await embedCommitHTTP(["x"], config, "mock", signal()), [[1, 0, 0]]);
  for (const p of [payload("different", [1, 0, 0]), payload("model", [0, 0, 0]), payload("model", [1, 2]), { model: "model", object: "list", data: [] }]) {
    globalThis.fetch = async () => Response.json(p); await assert.rejects(embedCommitHTTP(["x"], config, "mock", signal()), e => !String(e).includes("different"));
  }
  globalThis.fetch = async () => new Response("SECRET_AUTH_BODY", { status: 401 });
  await assert.rejects(embedCommitHTTP(["x"], config, "mock", signal()), e => !String(e).includes("SECRET"));
  const c = new AbortController(); globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("SECRET_AUTH_HEADER"))); });
  const pending = embedCommitHTTP(["x"], config, "mock", c.signal); c.abort(); await assert.rejects(pending, e => !String(e).includes("SECRET"));
});
