import { join } from "node:path";
import { withTaskDatabase } from "../project-tasks/storage.js";
import type { CachedTaskCandidate } from "./semantic-cache.js";
import { MAX_TASK_BYTES } from "../project-tasks/schema.js";

/** Read only the authoritative embedding projection, not status, links or
 * attachments. A missing store is empty; unsafe/corrupt stores fail closed. */
export async function readSemanticTaskCorpus(root: string, signal: AbortSignal): Promise<CachedTaskCandidate[]> {
  signal.throwIfAborted();
  return withTaskDatabase(join(root, ".pi"), "read", db => {
    if (!db) return [];
    // Background reads must not stall the host UI waiting for another writer.
    db.exec("PRAGMA busy_timeout=5; BEGIN");
    try {
      const rows = db.prepare(`SELECT id, length(CAST(payload AS BLOB)) AS payload_bytes, json_extract(payload,'$.id') AS payload_id,
        json_extract(payload,'$.title') AS title,
        json_extract(payload,'$.description') AS description, json_type(payload,'$.description') AS description_type
        FROM tasks ORDER BY id LIMIT 10001`).all();
      if (rows.length > 10_000) throw new Error("Task semantic corpus exceeds limit");
      const tasks = rows.map(row => {
        signal.throwIfAborted();
        if (typeof row.id !== "string" || row.payload_id !== row.id || typeof row.title !== "string"
          || Number(row.payload_bytes) > MAX_TASK_BYTES
          || (row.description_type !== null && row.description_type !== "text")) {
          throw new Error("Invalid task semantic projection");
        }
        return { id: row.id, title: row.title, description: row.description ?? undefined } as CachedTaskCandidate;
      });
      db.exec("COMMIT");
      return tasks;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
