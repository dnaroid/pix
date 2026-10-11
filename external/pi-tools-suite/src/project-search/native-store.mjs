import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const definitions = new Map([
  ["pix_native_meta", "CREATE TABLE pix_native_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, root TEXT NOT NULL, generation INTEGER NOT NULL, completed_at TEXT)"],
  ["pix_native_files", "CREATE TABLE pix_native_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL)"],
  ["pix_native_chunks", "CREATE TABLE pix_native_chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, is_test INTEGER NOT NULL)"],
  ["pix_native_fts", "CREATE VIRTUAL TABLE pix_native_fts USING fts5(id UNINDEXED, label, body, tokenize='unicode61')"],
  ["pix_native_by_path", "CREATE INDEX pix_native_by_path ON pix_native_chunks(path)"],
]);
const normalize = sql => sql.replace(/[\s;"`\[\]]/g, "").toLowerCase();
const shadows = new Set(["data", "idx", "content", "docsize", "config"].map(s => `pix_native_fts_${s}`));

async function safeDirectory(folder) {
  try { await mkdir(folder, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe native storage directory");
}
export async function checkStorage(root, filename) {
  for (const folder of [root, path.join(root, ".pi"), path.join(root, ".pi/search")]) {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe native storage directory");
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const info = await lstat(filename + suffix);
      if (!info.isFile() || info.isSymbolicLink() || (suffix ? info.nlink > 1 : info.nlink !== 1)
        || info.size > MAX_DATABASE_BYTES) throw new Error("Unsafe native database or sidecar");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
function validate(db, root) {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  for (const [name, sql] of definitions) {
    if (!objects.some(row => row.name === name && row.type === (sql.startsWith("CREATE INDEX") ? "index" : "table") && normalize(row.sql || "") === normalize(sql))) {
      throw new Error("Unknown native search schema");
    }
  }
  if (objects.some(row => row.name.startsWith("pix_native_") && !definitions.has(row.name) && !shadows.has(row.name))) {
    throw new Error("Unknown native search schema");
  }
  // Triggers could mutate unrelated data or replace the publishing protocol.
  if (objects.some(row => row.type === "trigger" && /pix_native_/i.test(row.sql || ""))) throw new Error("Unknown native search trigger");
  const meta = db.prepare("SELECT * FROM pix_native_meta").all();
  if (meta.length !== 1 || meta[0].singleton !== 1 || meta[0].version !== 1 || meta[0].root !== root
    || !Number.isSafeInteger(meta[0].generation) || meta[0].generation < 0) throw new Error("Unknown native search identity");
}

export async function openStore(root) {
  if (await realpath(root) !== root) throw new Error("Unsafe project root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe project root");
  await safeDirectory(path.join(root, ".pi"));
  await safeDirectory(path.join(root, ".pi/search"));
  const filename = path.join(root, ".pi/search/files.sqlite");
  await checkStorage(root, filename);
  try {
    const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (e) { if (e.code !== "EEXIST") throw e; }
  await checkStorage(root, filename);
  let db;
  if ("Bun" in globalThis) {
    const { Database } = await import("bun:sqlite");
    db = new Database(filename, { readwrite: true, create: false });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename);
  }
  try {
    db.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
    try {
      const objects = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (!objects.length) {
        if (db.prepare("PRAGMA user_version").get().user_version !== 0
          || db.prepare("PRAGMA application_id").get().application_id !== 0) throw new Error("Unknown native schema version");
        for (const sql of definitions.values()) db.exec(sql);
        db.prepare("INSERT INTO pix_native_meta VALUES(1,1,?,0,NULL)").run(root);
      }
      validate(db, root);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const maxPages = Math.floor(MAX_DATABASE_BYTES / db.prepare("PRAGMA page_size").get().page_size);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA max_page_count=${maxPages}`);
    await checkStorage(root, filename);
    return { db, root, filename, close: () => db.close() };
  } catch (e) { db.close(); throw e; }
}

/** No writer lock is held during filesystem reads/hashing. */
export function snapshot(store) {
  const { db } = store;
  db.exec("BEGIN");
  try {
    const meta = db.prepare("SELECT generation,completed_at FROM pix_native_meta WHERE singleton=1").get();
    const files = new Map(db.prepare("SELECT path,hash FROM pix_native_files ORDER BY path LIMIT 10001").all().map(row => [row.path, row.hash]));
    if (files.size > 10000) throw new Error("Native index exceeds file cap");
    if (db.prepare("SELECT COUNT(*) AS count FROM (SELECT 1 FROM pix_native_chunks LIMIT 20001)").get().count > 20000) throw new Error("Native index exceeds chunk cap");
    const chunkCounts = new Map(db.prepare("SELECT path,COUNT(*) AS count FROM pix_native_chunks GROUP BY path").all().map(row => [row.path, row.count]));
    db.exec("COMMIT");
    return { ...meta, files, chunkCounts };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function searchTokens(text) {
  return text.normalize("NFKC").replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2").toLowerCase().replace(/ё/g, "е")
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** CAS protects against a slow scan replacing a newer completed generation. */
export function publish(store, previous, scan) {
  const { db } = store;
  db.exec("BEGIN IMMEDIATE");
  try {
    validate(db, store.root);
    const current = db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation;
    if (current !== previous.generation) { db.exec("ROLLBACK"); return false; }
    const removeChunks = db.prepare("DELETE FROM pix_native_chunks WHERE path=?");
    const removeFts = db.prepare("DELETE FROM pix_native_fts WHERE id IN (SELECT id FROM pix_native_chunks WHERE path=?)");
    const removeFile = db.prepare("DELETE FROM pix_native_files WHERE path=?");
    const upsertFile = db.prepare("INSERT INTO pix_native_files(path,hash) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash");
    const insertChunk = db.prepare("INSERT INTO pix_native_chunks VALUES(?,?,?,?,?,?,?,?)");
    const insertFts = db.prepare("INSERT INTO pix_native_fts(id,label,body) VALUES(?,?,?)");
    for (const name of previous.files.keys()) {
      if (!scan.files.has(name)) { removeFts.run(name); removeChunks.run(name); removeFile.run(name); }
    }
    for (const [name, file] of scan.files) {
      if (previous.files.get(name) === file.hash) continue;
      removeFts.run(name); removeChunks.run(name); upsertFile.run(name, file.hash);
      for (const chunk of file.chunks) {
        insertChunk.run(chunk.id, name, chunk.kind, chunk.title, chunk.startLine, chunk.endLine, chunk.content, chunk.isTest ? 1 : 0);
        insertFts.run(chunk.id, searchTokens(`${name} ${chunk.title}`).join(" "), searchTokens(chunk.content).join(" "));
      }
    }
    if (db.prepare("SELECT COUNT(*) AS count FROM pix_native_chunks").get().count > 20000) throw new Error("Native index exceeds chunk cap");
    db.prepare("UPDATE pix_native_meta SET generation=generation+1,completed_at=? WHERE singleton=1").run(new Date().toISOString());
    db.exec("COMMIT");
    return true;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function chunkHit(row, score, request) {
  if (typeof row.path !== "string" || row.path.length > 4096 || row.path.includes("\\") || row.path.includes("\0")
    || row.path.split("/").some(part => !part || part === "." || part === "..")
    || !["code", "knowledge"].includes(row.kind) || typeof row.id !== "string" || row.id.length > 8192
    || typeof row.content !== "string" || row.content.length > 8000 || typeof row.title !== "string" || row.title.length > 8000
    || !Number.isSafeInteger(row.start_line) || !Number.isSafeInteger(row.end_line)
    || row.start_line < 1 || row.end_line < row.start_line || row.end_line - row.start_line >= 60) throw new Error("Invalid native hit");
  return { kind: row.kind, id: row.id, title: row.title, path: row.path,
    startLine: row.start_line, endLine: row.end_line,
    snippet: row.content.replace(/\s+/gu, " ").trim().slice(0, 500), score,
    ...(request.includeContent ? { content: row.content } : {}) };
}

export function queryStore(store, request) {
  const terms = [...new Set(searchTokens(request.query))].slice(0, 12);
  const { db } = store;
  db.exec("BEGIN");
  try {
    const meta = db.prepare("SELECT generation,completed_at FROM pix_native_meta WHERE singleton=1").get();
    let rows = [];
    if (terms.length) {
      const where = ["pix_native_fts MATCH ?", `c.kind IN (${request.sources.map(() => "?").join(",")})`];
      const params = [terms.map(term => `"${term}"*`).join(" OR "), ...request.sources];
      if (request.pathPrefix) {
        where.push("(c.path=? OR substr(c.path,1,?)=?)");
        params.push(request.pathPrefix, request.pathPrefix.length + 1, request.pathPrefix + "/");
      }
      if (request.excludeTests) where.push("c.is_test=0");
      const rank = `bm25(pix_native_fts,0,4,1)${request.includeTests ? "" : " * CASE WHEN c.is_test=1 THEN 0.6 ELSE 1 END"}`;
      rows = db.prepare(`SELECT c.*,${rank} AS rank FROM pix_native_fts
        JOIN pix_native_chunks c ON c.id=pix_native_fts.id WHERE ${where.join(" AND ")}
        ORDER BY rank ASC,c.path COLLATE BINARY ASC,c.start_line ASC LIMIT 200`).all(...params);
    }
    db.exec("COMMIT");
    const seen = new Set();
    const hits = [];
    for (const row of rows) {
      if (request.dedupeFile && seen.has(row.path)) continue;
      seen.add(row.path);
      hits.push(chunkHit(row, Math.min(1, Math.max(0, -row.rank / (1 - row.rank))), request));
      if (hits.length >= (request.limit || 10)) break;
    }
    return { hits, meta, capped: rows.length === 200 };
  } catch (e) { if (db.inTransaction ?? true) { try { db.exec("ROLLBACK"); } catch {} } throw e; }
}
