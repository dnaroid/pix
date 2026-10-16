import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeDirsWithRetry } from "../../external/pi-tools-suite/test/support/fs-retry.mjs";
import { SearchIndexStore } from "../src/search/index-store.js";
import { settingsDocuments, hashText } from "../src/search/documents.js";
import { embeddingMetadata } from "../src/search/embedding-cache.js";
import type { SemanticEmbeddingConfig } from "../src/search/config.js";
import { isolateSearchHome } from "./search-sources-fixture.js";

const config: SemanticEmbeddingConfig = { provider: "ollama", model: "fixture", dimension: 3, baseUrl: "http://localhost:11434", queryPrefix: "", documentPrefix: "" };
const signal = () => new AbortController().signal;
const documents = (name: string) => settingsDocuments([{ id: "shared", section: "General", label: name, description: "", synonyms: [] }]);
async function fixture(t: TestContext) {
  const base = resolve(".pi/artifacts/settings-global/fixtures"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  const restore = await isolateSearchHome(root);
  const a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
  t.after(async () => { await removeDirsWithRetry([root]); restore(); });
  return { a, b, store: new SearchIndexStore() };
}
async function legacy(cwd: string, docs = documents("Original"), model = config, corrupt = false) {
  await mkdir(join(cwd, ".pi/search"), { recursive: true });
  const filename = join(cwd, ".pi/search/settings.sqlite"), db = new DatabaseSync(filename);
  try {
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY,text TEXT,hit TEXT,hashes TEXT); CREATE TABLE vectors(hash TEXT PRIMARY KEY,vector BLOB)");
    for (const [key, value] of Object.entries({ schema: "2", ...embeddingMetadata(model) })) db.prepare("INSERT INTO metadata VALUES(?,?)").run(key, value);
    for (const doc of docs) {
      db.prepare("INSERT INTO documents VALUES(?,?,?,?)").run(doc.hit.id, doc.text, JSON.stringify(doc.hit), JSON.stringify(doc.chunks.map(hashText)));
      for (const chunk of doc.chunks) { const vector = Buffer.alloc(corrupt ? 4 : 12); vector.writeFloatLE(1); db.prepare("INSERT INTO vectors VALUES(?,?)").run(hashText(chunk), vector); }
    }
  } finally { db.close(); }
  return filename;
}

test("global cache reuses A/B/A catalogues and never loads another caller's hashes", async t => {
  const f = await fixture(t), first = documents("Original"), second = documents("New version"); let paid = 0;
  const index = (cwd: string, docs: ReturnType<typeof documents>) => f.store.write(cwd, signal(), async tx => {
    const cache = await tx.load(docs);
    for (const doc of docs) for (const chunk of doc.chunks) if (!cache.vectors.has(hashText(chunk))) { paid++; cache.vectors.set(hashText(chunk), [1, 0, 0]); }
    await tx.save(docs, cache.vectors);
  }, config);
  assert.equal(f.store.path(f.a), f.store.path(f.b));
  await Promise.all([index(f.a, first), index(f.b, first)]); assert.equal(paid, 1);
  await index(f.b, second); await index(f.a, []); await index(f.a, first); assert.equal(paid, 2);
  assert.deepEqual([...((await f.store.read(f.b, signal(), config, second)).vectors.keys())], second[0]!.chunks.map(hashText));
  assert.equal((await f.store.read(f.a, signal(), config, [])).vectors.size, 0);
  await assert.rejects(indexWithWrongIdentity(), /incompatible|rebuild/i);
  function indexWithWrongIdentity() { return f.store.write(f.b, signal(), async tx => { await tx.load(first); }, { ...config, model: "other" }); }
  assert.equal((await f.store.read(f.a, signal(), config, first)).vectors.size, 1);
});

test("compatible legacy migration is provider-free, idempotent, non-destructive and cross-project", async t => {
  const f = await fixture(t), docs = documents("Original"), filename = await legacy(f.a, docs);
  const before = await readFile(filename);
  for (let i = 0; i < 2; i++) await f.store.write(f.a, signal(), async tx => { assert.equal((await tx.load(docs)).vectors.size, 1); }, config);
  assert.deepEqual(await readFile(filename), before);
  assert.equal((await f.store.read(f.b, signal(), config, docs)).vectors.size, 1);
});

test("incompatible legacy identity is skipped; corrupt compatible migration rolls back", async t => {
  const f = await fixture(t), docs = documents("Original");
  await legacy(f.a, docs, { ...config, model: "old" });
  await f.store.write(f.a, signal(), async tx => { assert.equal((await tx.load(docs)).vectors.size, 0); }, config);
  await legacy(f.b, docs, config, true);
  await assert.rejects(f.store.write(f.b, signal(), async () => {}, config), /Invalid legacy settings vector/);
  assert.equal((await f.store.read(f.a, signal(), config, docs)).vectors.size, 0);
  const db = new DatabaseSync(f.store.path(f.a));
  try { assert.equal(db.prepare("SELECT count(*) n FROM documents").get()!.n, 0); } finally { db.close(); }
});
