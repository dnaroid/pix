import type { DatabaseSync } from "node:sqlite";

/** Pix-owned namespace, separate from task/session embedding tables. */
export const COMMIT_META = "pix_commit_meta";
export const COMMIT_VECTORS = "pix_commit_vectors";
export const COMMIT_DOCUMENTS = "pix_commit_documents";

/** Commit metadata and vectors live only in git-commits.sqlite. */
export function createCommitTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${COMMIT_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${COMMIT_VECTORS} (hash TEXT PRIMARY KEY, vector TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${COMMIT_DOCUMENTS} (
      hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL, metadata TEXT NOT NULL, message TEXT NOT NULL
    )`);
}
