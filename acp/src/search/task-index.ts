import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTask } from "node:timers/promises";
import { SEARCH_EMBEDDING_MODEL } from "./contract.js";
import { EMBEDDING_DIMENSIONS, validVector } from "./embeddings.js";

export interface TaskSemanticDocument {
  id: string;
  title: string;
  text: string;
  hash: string;
  snippet: string;
}

export interface TaskIndexTransaction {
  reconcile(tasks: readonly TaskSemanticDocument[]): void;
  missing(limit: number): TaskSemanticDocument[];
  save(vectors: ReadonlyMap<string, number[]>): void;
}

const identity = [SEARCH_EMBEDDING_MODEL, String(EMBEDDING_DIMENSIONS), "float32le"] as const;

/** Namespaced task index. It never stores task text or alters canonical tasks.sqlite. */
export function taskIndexTransaction(db: DatabaseSync): TaskIndexTransaction {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_task_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_documents (task_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_vectors (content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);
    CREATE TEMP TABLE IF NOT EXISTS pix_live_task_ids (id TEXT PRIMARY KEY);`);
  const get = db.prepare("SELECT value FROM pix_task_index_meta WHERE key=?");
  const prior = db.prepare("SELECT COUNT(*) AS count FROM pix_task_index_meta").get();
  if (Number(prior?.count) > 0
    && identity.some((value, index) => get.get(["model", "dimensions", "encoding"][index]!)?.value !== value)) {
    // An incompatible/corrupt namespace fails closed. Never silently erase
    // already-purchased embeddings; this matches session-title semantics.
    throw new Error("Task embedding identity is incompatible");
  }
  const set = db.prepare("INSERT INTO pix_task_index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  ["model", "dimensions", "encoding"].forEach((key, index) => set.run(key, identity[index]!));
  let corpus: readonly TaskSemanticDocument[] = [];
  return {
    reconcile(tasks) {
      corpus = tasks;
      db.exec("DELETE FROM pix_live_task_ids");
      const live = db.prepare("INSERT OR IGNORE INTO pix_live_task_ids VALUES(?)");
      const put = db.prepare("INSERT INTO pix_task_documents(task_id,content_hash) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET content_hash=excluded.content_hash WHERE content_hash!=excluded.content_hash");
      for (const task of tasks) {
        live.run(task.id);
        put.run(task.id, task.hash);
      }
      db.exec(`DELETE FROM pix_task_documents WHERE task_id NOT IN (SELECT id FROM pix_live_task_ids);
        DELETE FROM pix_task_vectors WHERE content_hash NOT IN (SELECT content_hash FROM pix_task_documents);`);
    },
    missing(limit) {
      const stored = db.prepare("SELECT content_hash FROM pix_task_vectors").all();
      const hashes = new Set(stored.map(row => row.content_hash));
      const selected = new Set<string>();
      return corpus.filter(task => !hashes.has(task.hash) && !selected.has(task.hash) && (selected.add(task.hash), true)).slice(0, limit);
    },
    save(vectors) {
      const put = db.prepare("INSERT INTO pix_task_vectors(content_hash,vector) VALUES(?,?) ON CONFLICT(content_hash) DO NOTHING");
      for (const [hash, vector] of vectors) {
        if (!/^[a-f0-9]{64}$/.test(hash) || !validVector(vector)) throw new Error("Invalid task vector");
        const buffer = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
        vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
        put.run(hash, buffer);
      }
    },
  };
}

/** Reads only trusted vector blobs. Query-time canonical row hashes are compared
 * separately so stale index entries cannot produce stale task results. */
export async function readTaskVectors(db: DatabaseSync, signal: AbortSignal): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pix_task_index_meta'").get()) return result;
  const get = db.prepare("SELECT value FROM pix_task_index_meta WHERE key=?");
  if (identity.some((value, index) => get.get(["model", "dimensions", "encoding"][index]!)?.value !== value)) return result;
  let count = 0;
  for (const row of db.prepare("SELECT content_hash,vector FROM pix_task_vectors").iterate()) {
    signal.throwIfAborted();
    if (typeof row.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.content_hash)
      || !(row.vector instanceof Uint8Array) || row.vector.byteLength !== EMBEDDING_DIMENSIONS * 4) continue;
    const buffer = Buffer.from(row.vector);
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => buffer.readFloatLE(index * 4));
    if (validVector(vector)) result.set(row.content_hash, vector);
    if (++count % 32 === 0) await yieldTask();
  }
  return result;
}
