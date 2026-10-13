import { lstat } from "node:fs/promises";
import { beginWrite, openDatabase, sourceDirectories, sourcePath } from "./source-work.mjs";

const TABLE = "pix_session_sweep";
const schema = `CREATE TABLE IF NOT EXISTS ${TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, started_at INTEGER NOT NULL, incarnation TEXT NOT NULL, revision INTEGER NOT NULL)`;
// Filesystem timestamps may be rounded; equality and a small overlap are work,
// never evidence that a transcript was already covered.
export const SESSION_WATERMARK_OVERLAP_MS = 2000;
function revision(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pix_session_revision'").get()) return;
  const rows = db.prepare("SELECT incarnation,revision FROM pix_session_revision LIMIT 2").all();
  const row = rows[0];
  if (rows.length !== 1 || typeof row.incarnation !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error("Unsafe session revision");
  return row;
}
const saved = db => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
  ? db.prepare(`SELECT * FROM ${TABLE} WHERE singleton=1`).get() : undefined;
const matches = (row, current) => row && current && row.incarnation === current.incarnation && row.revision === current.revision;
async function openExisting(root, readOnly) {
  for (const directory of sourceDirectories(root, "sessions")) {
    const info = await lstat(directory).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search directory");
  }
  const path = sourcePath(root, "sessions");
  if (!await lstat(path).catch(e => { if (e.code !== "ENOENT") throw e; })) return;
  return openDatabase(path, { readOnly });
}

/** A scalar checkpoint in the cache itself. No transcript manifest is persisted.
 * Cache replacement, later content writes, or a new model force a full sweep. */
export async function beginSessionSweep(root, identity, signal, now = Date.now) {
  const startedAt = now();
  signal.throwIfAborted();
  const db = await openExisting(root, true);
  let since = 0;
  let cacheRevision = "absent";
  let incarnation;
  try {
    if (db) {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
      const row = saved(db);
      const current = revision(db);
      cacheRevision = JSON.stringify(current ?? null);
      incarnation = current?.incarnation;
      if (row?.identity === identity && matches(row, current) && Number.isSafeInteger(row.started_at)
        && row.started_at > 0 && row.started_at <= startedAt) since = Math.max(0, row.started_at - SESSION_WATERMARK_OVERLAP_MS);
    }
  } finally { if (db) { try { db.exec("ROLLBACK"); } finally { db.close(); } } }
  signal.throwIfAborted();
  return { startedAt, since, identity, cacheRevision, incarnation };
}

export async function completeSessionSweep(root, pass, signal, now = Date.now) {
  signal.throwIfAborted();
  if (now() < pass.startedAt) return;
  const db = await openExisting(root, false);
  if (!db) return;
  try {
    await beginWrite(db, signal);
    try {
      const current = revision(db);
      if (current && (!pass.incarnation || current.incarnation === pass.incarnation)) {
        db.exec(schema);
        const previous = saved(db);
        if (Number.isSafeInteger(previous?.started_at) && previous.started_at > pass.startedAt) {
          db.exec("COMMIT");
          return;
        }
        signal.throwIfAborted();
        db.prepare(`INSERT INTO ${TABLE} VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
          identity=excluded.identity,started_at=excluded.started_at,incarnation=excluded.incarnation,revision=excluded.revision`)
          .run(pass.identity, pass.startedAt, current.incarnation, current.revision);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } finally { db.close(); }
}
