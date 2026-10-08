import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validCommitVector } from "./commit-provider.js";

/** Pix-owned namespace; IDX uses vec_chunks/vector_meta and is not modified. */
export const COMMIT_META = "pix_commit_meta";
export const COMMIT_VECTORS = "pix_commit_vectors";
export const COMMIT_DOCUMENTS = "pix_commit_documents";

/** These tables share the canonical settings SQLite file, not its vector model. */
export function createCommitTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${COMMIT_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${COMMIT_VECTORS} (hash TEXT PRIMARY KEY, vector TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${COMMIT_DOCUMENTS} (
      hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL, metadata TEXT NOT NULL, message TEXT NOT NULL
    )`);
}

async function legacyStamp(file: string): Promise<string | undefined> {
  const details: Array<[string, number, number, number]> = [];
  let mainPresent = false;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = file + suffix;
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Legacy commit index has an unsafe file type");
      if (!suffix) mainPresent = true;
      details.push([suffix, entry.ino, entry.size, entry.mtimeMs]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return mainPresent ? JSON.stringify(details) : undefined;
}

/** Non-destructive, transactional import of pre-unification commit vectors.
 * Never unlinks or mutates commits.sqlite. The importer is called under the
 * canonical database's BEGIN IMMEDIATE transaction and safely retries later.
 */
export async function importLegacyCommitVectors(db: DatabaseSync, root: string, signal: AbortSignal): Promise<void> {
  const file = join(root, ".pi", "search", "commits.sqlite");
  const stamp = await legacyStamp(file);
  signal.throwIfAborted();
  if (!stamp) return;
  if (db.prepare(`SELECT value FROM ${COMMIT_META} WHERE key='legacy_stamp'`).get()?.value === stamp) return;

  const legacy = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of ["meta", "vectors", "commits"]) {
      if (!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error("Legacy commit index has an unexpected schema");
      }
    }
    const identity = legacy.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value;
    if (typeof identity !== "string") return;
    const parsed: unknown = JSON.parse(identity);
    if (!Array.isArray(parsed) || parsed[0] !== 1 || !Number.isInteger(parsed[3]) || parsed[3] < 1 || parsed[3] > 8192) {
      throw new Error("Legacy commit index has invalid embedding identity");
    }
    const existing = db.prepare(`SELECT value FROM ${COMMIT_META} WHERE key='identity'`).get()?.value;
    // Never mix embeddings from different models or dimensions.
    if (existing !== undefined && existing !== identity) return;
    if (existing === undefined) {
      db.prepare(`INSERT INTO ${COMMIT_META} VALUES ('identity', ?)`).run(identity);
    }
    const addVector = db.prepare(`INSERT OR IGNORE INTO ${COMMIT_VECTORS} VALUES (?, ?)`);
    for (const row of legacy.prepare("SELECT hash, vector FROM vectors").iterate()) {
      signal.throwIfAborted();
      if (typeof row.hash !== "string" || typeof row.vector !== "string") continue;
      let values: unknown;
      try { values = JSON.parse(row.vector); } catch { continue; }
      if (validCommitVector(values, parsed[3] as number)) addVector.run(row.hash, row.vector);
    }
    const addCommit = db.prepare(`INSERT OR IGNORE INTO ${COMMIT_DOCUMENTS} VALUES (?, ?, ?, ?)`);
    for (const row of legacy.prepare("SELECT hash, content_hash, metadata, message FROM commits").iterate()) {
      signal.throwIfAborted();
      if (typeof row.hash === "string" && typeof row.content_hash === "string" &&
          typeof row.metadata === "string" && typeof row.message === "string") {
        addCommit.run(row.hash, row.content_hash, row.metadata, row.message);
      }
    }
    db.prepare(`INSERT INTO ${COMMIT_META} VALUES ('legacy_stamp', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(stamp);
  } finally {
    legacy.close();
  }
}
