import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetHistoryVectors } from "../src/project-search/semantic-reset.js";

const roots: string[] = [];
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const signal = () => new AbortController().signal;
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "semantic-reset-")); roots.push(root);
  await mkdir(join(root, ".pi/search"), { recursive: true });
  return { root, file: join(root, ".pi/search/index.sqlite") };
}
function populate(file: string) {
  const db = new Database(file);
  for (const [meta, vectors, hash, type] of [
    ["pix_task_index_meta", "pix_task_vectors", "content_hash", "BLOB"],
    ["pix_session_meta", "pix_session_vectors", "title_hash", "BLOB"],
    ["pix_commit_meta", "pix_commit_vectors", "hash", "TEXT"],
    ["metadata", "vectors", "hash", "BLOB"],
  ]) {
    db.exec(`CREATE TABLE ${meta}(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE ${vectors}(${hash} TEXT PRIMARY KEY,vector ${type} NOT NULL);
      INSERT INTO ${meta} VALUES ('identity','old-model');
      INSERT INTO ${vectors} VALUES ('paid-vector',X'0000803f');`);
  }
  db.exec(`INSERT INTO metadata VALUES ('schema','2'),('model','old'),('dimensions','1'),('encoding','f32le');
    INSERT INTO pix_commit_meta VALUES ('legacy_stamp','already-imported');
    CREATE TABLE documents(id TEXT PRIMARY KEY,body TEXT);
    INSERT INTO documents VALUES ('setting','local document');
    CREATE TABLE unrelated(id TEXT PRIMARY KEY,body TEXT);
    INSERT INTO unrelated VALUES ('canonical','untouched');`);
  db.close();
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });

test("explicit reset removes only history vectors and identity metadata, preserving canonical files and legacy markers", async () => {
  const f = await fixture(); populate(f.file);
  const tasks = join(f.root, ".pi/tasks.sqlite"); await writeFile(tasks, "canonical task bytes");
  const repository = join(f.root, ".pi/search/file-vectors.sqlite"); await writeFile(repository, "repository vectors");
  expect(await resetHistoryVectors(f.root, signal())).toBe(4);
  const db = new Database(f.file);
  try {
    for (const table of ["pix_task_vectors", "pix_session_vectors", "pix_commit_vectors", "vectors", "pix_task_index_meta", "pix_session_meta"]) {
      expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.query("SELECT * FROM metadata").all()).toEqual([{ key: "schema", value: "2" }]);
    expect(db.query("SELECT * FROM pix_commit_meta").all()).toEqual([{ key: "legacy_stamp", value: "already-imported" }]);
    expect(db.query("SELECT body FROM documents").get()).toEqual({ body: "local document" });
    expect(db.query("SELECT body FROM unrelated").get()).toEqual({ body: "untouched" });
  } finally { db.close(); }
  expect(await readFile(tasks, "utf8")).toBe("canonical task bytes");
  expect(await readFile(repository, "utf8")).toBe("repository vectors");
  expect(await resetHistoryVectors(f.root, signal())).toBe(0);
});

test("unknown schema or deletion dependencies fail atomically before touching purchased vectors", async () => {
  for (const mutation of [
    "ALTER TABLE pix_session_vectors ADD COLUMN unexpected TEXT",
    "CREATE TRIGGER dangerous AFTER DELETE /* hidden boundary */ ON pix_session_vectors BEGIN DELETE FROM unrelated; END",
    "CREATE TABLE dependent(id TEXT REFERENCES pix_task_vectors(content_hash) ON DELETE CASCADE)",
    "UPDATE metadata SET value='future-version' WHERE key='schema'",
  ]) {
    const f = await fixture(); populate(f.file);
    const before = new Database(f.file); before.exec(mutation); before.close();
    await expect(resetHistoryVectors(f.root, signal())).rejects.toThrow();
    const db = new Database(f.file);
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM pix_task_vectors").get()).toEqual({ count: 1 });
      expect(db.query("SELECT COUNT(*) AS count FROM unrelated").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  }
});

test("missing index is a no-op; cancellation and redirected storage fail closed", async () => {
  const f = await fixture();
  expect(await resetHistoryVectors(f.root, signal())).toBe(0);
  populate(f.file);
  const aborted = new AbortController(); aborted.abort();
  await expect(resetHistoryVectors(f.root, aborted.signal)).rejects.toThrow();
  const other = await fixture(); await symlink(f.file, other.file);
  await expect(resetHistoryVectors(other.root, signal())).rejects.toThrow();
  const db = new Database(f.file);
  try { expect(db.query("SELECT COUNT(*) AS count FROM pix_task_vectors").get()).toEqual({ count: 1 }); }
  finally { db.close(); }
});

test("a cancelled reset waiting behind an active writer preserves every namespace", async () => {
  const f = await fixture(); populate(f.file);
  const writer = new Database(f.file);
  writer.exec("BEGIN IMMEDIATE");
  try {
    await expect(resetHistoryVectors(f.root, AbortSignal.timeout(40))).rejects.toThrow();
    for (const table of ["pix_task_vectors", "pix_session_vectors", "pix_commit_vectors", "vectors"]) {
      expect(writer.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
  } finally { writer.exec("ROLLBACK"); writer.close(); }
});
