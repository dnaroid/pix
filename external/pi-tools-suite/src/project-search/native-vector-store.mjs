import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkStorage, MAX_DATABASE_BYTES } from "./native-store.mjs";
import { validVector } from "./native-embedding-provider.mjs";

const definitions = [
  "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, root TEXT NOT NULL)",
  "CREATE TABLE vectors (identity TEXT NOT NULL, digest TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(identity,digest))",
  "CREATE TABLE leases (identity TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL)",
];
const normalize = sql => sql.replace(/[\s;"`\[\]]/g, "").toLowerCase();
const MAX_VECTORS = 50000;

/** Separate optional vector cache: no migration of paid history or lexical tables.
 * Expiring leases serialize provider work without holding SQLite locks over HTTP. */
export async function openVectorStore(root) {
  const filename = join(root, ".pi/search/file-vectors.sqlite");
  await checkStorage(root, filename);
  try {
    const file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.close();
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  await checkStorage(root, filename);
  let db;
  if ("Bun" in globalThis) { const { Database } = await import("bun:sqlite"); db = new Database(filename, { readwrite: true, create: false }); }
  else { const { DatabaseSync } = await import("node:sqlite"); db = new DatabaseSync(filename); }
  try {
    db.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
    try {
      let objects = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (!objects.length) {
        if (db.prepare("PRAGMA user_version").get().user_version !== 0 || db.prepare("PRAGMA application_id").get().application_id !== 0) throw new Error("Unknown vector schema");
        for (const sql of definitions) db.exec(sql);
        db.prepare("INSERT INTO meta VALUES(1,1,?)").run(root);
        objects = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      }
      if (objects.length !== definitions.length || definitions.some(sql => !objects.some(row => normalize(row.sql || "") === normalize(sql)))) throw new Error("Unknown vector schema");
      const meta = db.prepare("SELECT * FROM meta").all();
      if (meta.length !== 1 || meta[0].version !== 1 || meta[0].root !== root || meta[0].singleton !== 1) throw new Error("Unknown vector identity");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const pages = Math.floor(MAX_DATABASE_BYTES / db.prepare("PRAGMA page_size").get().page_size);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA max_page_count=${pages}`);
    const read = db.prepare("SELECT vector FROM vectors WHERE identity=? AND digest=?");
    const lease = db.prepare("SELECT token,expires FROM leases WHERE identity=?");
    const insert = db.prepare("INSERT OR IGNORE INTO vectors VALUES(?,?,?)");
    return {
      filename,
      close: () => db.close(),
      get(identity, digest, dimension) {
        const row = read.get(identity, digest);
        if (!row) return;
        const bytes = Buffer.from(row.vector);
        if (bytes.length !== dimension * 4) throw new Error("Invalid cached vector");
        const vector = Array.from({ length: dimension }, (_, i) => bytes.readFloatLE(i * 4));
        if (!validVector(vector, dimension)) throw new Error("Invalid cached vector");
        return vector;
      },
      acquire(identity) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const now = Date.now(), current = lease.get(identity);
          if (current?.expires > now) { db.exec("ROLLBACK"); return; }
          if (db.prepare("SELECT COUNT(*) AS count FROM vectors").get().count >= MAX_VECTORS) throw new Error("Vector cache full");
          const token = randomUUID();
          db.prepare("DELETE FROM leases WHERE expires<=?").run(now);
          db.prepare("INSERT INTO leases VALUES(?,?,?)").run(identity, token, now + 60000);
          db.exec("COMMIT");
          return token;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
      put(identity, token, entries, dimension) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = lease.get(identity);
          if (current?.token !== token || current.expires <= Date.now()) throw new Error("Vector lease lost");
          if (db.prepare("SELECT COUNT(*) AS count FROM vectors").get().count + entries.length > MAX_VECTORS) throw new Error("Vector cache full");
          for (const entry of entries) {
            if (!validVector(entry.vector, dimension)) throw new Error("Invalid new vector");
            const bytes = Buffer.alloc(dimension * 4);
            entry.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
            insert.run(identity, entry.digest, bytes);
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
      release(identity, token) { db.prepare("DELETE FROM leases WHERE identity=? AND token=?").run(identity, token); },
    };
  } catch (error) { db.close(); throw error; }
}
