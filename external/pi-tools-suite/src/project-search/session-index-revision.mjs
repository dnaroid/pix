import { randomUUID, createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { openDatabase, sourcePath } from "./source-work.mjs";

const TABLE = "pix_session_revision";
const definition = `CREATE TABLE ${TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1), incarnation TEXT NOT NULL, revision INTEGER NOT NULL)`;
const watched = {
  pix_session_meta: ["key", "value"],
  pix_session_titles: ["session_id", "title", "title_hash"],
  pix_session_vectors: ["title_hash", "vector"],
  pix_session_chunk_meta: ["session_id", "path", "revision", "head"],
  pix_session_chunks: ["session_id", "message_id", "start", "end", "ordinal", "role", "status", "text", "hash"],
  pix_session_chunk_vectors: ["identity", "hash", "vector"],
  pix_session_indexed_files: ["session_id", "cwd", "path", "file_stamp", "revision", "head", "format", "title", "name", "first_message"],
  pix_session_chunk_ranges: ["session_id", "message_id", "start", "byte_offset", "byte_length", "snippet", "active"],
};
const normalize = sql => sql.replace(/\bIF NOT EXISTS\b/gi, "").replace(/[\s;"`\[\]]/g, "").toLowerCase();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function tables(db) {
  return Object.entries(watched).filter(([name, columns]) => {
    const found = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    if (!found) return false;
    if (found.type !== "table") throw new Error("Unsafe session schema");
    const actual = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
    if (actual.join() !== columns.join()) throw new Error("Unknown session schema");
    return true;
  });
}
function triggers(name, columns) {
  return ["INSERT", "DELETE", "UPDATE"].map(event => {
    const trigger = `pix_revision_${name}_${event.toLowerCase()}`;
    const condition = event === "UPDATE" ? ` WHEN ${columns.map(c => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}` : "";
    return [trigger, `CREATE TRIGGER ${trigger} AFTER ${event} ON ${name}${condition} BEGIN UPDATE ${TABLE} SET revision=revision+1 WHERE singleton=1; END`];
  });
}
/** Called inside the writer transaction after schema creation. Trigger updates
 * share the content commit; lease/activity/FTS maintenance cannot bump revision. */
export function ensureSessionRevision(db) {
  db.exec(definition.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
  db.prepare(`INSERT OR IGNORE INTO ${TABLE} VALUES(1,?,0)`).run(randomUUID());
  for (const [name, columns] of tables(db)) for (const [, sql] of triggers(name, columns)) {
    db.exec(sql.replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS"));
  }
}
export async function readSessionIndexRevision(root, signal) {
  signal.throwIfAborted();
  const filename = sourcePath(root, "sessions");
  if (!await lstat(filename).catch(e => { if (e.code !== "ENOENT") throw e; })) return { present: false, index: digest(["sessions-logical-v1", "absent"]) };
  const db = await openDatabase(filename, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const available = tables(db);
    const stored = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(TABLE);
    if (stored && (stored.type !== "table" || normalize(stored.sql) !== normalize(definition))) throw new Error("Unsafe session revision");
    const tracked = stored && available.every(([name, cols]) => triggers(name, cols).every(([trigger, sql]) => {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(trigger);
      return row?.type === "trigger" && normalize(row.sql) === normalize(sql);
    }));
    if (tracked) {
      const rows = db.prepare(`SELECT incarnation,revision FROM ${TABLE}`).all();
      if (rows.length !== 1 || typeof rows[0].incarnation !== "string" || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) throw new Error("Unsafe session revision");
      return { present: true, index: digest(["sessions-logical-v1", rows[0], available.map(([name]) => name)]) };
    }
    // Legacy caches remain readable without a migration during status polling.
    // Hash bounded metadata only; no vectors or transcript text are loaded.
    const content = [];
    let count = 0;
    for (const [name, columns] of available) {
      const selected = columns.filter(c => c !== "text" && c !== "title");
      const query = selected.map(c => c === "vector" ? "length(vector) AS bytes" : c).join(",");
      const rows = [];
      for (const row of db.prepare(`SELECT ${query} FROM ${name} ORDER BY ${selected.filter(c => c !== "vector").join(",")} LIMIT 100001`).iterate()) {
        signal.throwIfAborted();
        if (++count > 100000 || JSON.stringify(row).length > 16384) throw new Error("Session revision bound");
        rows.push(row);
      }
      content.push([name, rows]);
    }
    return { present: true, index: digest(["sessions-legacy-logical-v1", content]) };
  } finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
}
