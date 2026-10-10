import { taskSemanticHash, taskSemanticText, freshSemanticCandidates, type CachedTaskCandidate } from "./semantic-cache.js";
import { embedTaskTexts, semanticConsents, validSearchVector, SEARCH_VECTOR_DIMENSIONS, SEARCH_VECTOR_MODEL,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

const MAX_NEW_VECTORS_PER_QUERY = 256;
const BATCH_SIZE = 16;
const TASK_INDEX_DEADLINE_MS = 40_000;

function ensureTaskSchema(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_task_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_documents(task_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_vectors(content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);`);
  const meta = db.prepare("SELECT value FROM pix_task_index_meta WHERE key=?");
  const values = [["model", SEARCH_VECTOR_MODEL], ["dimensions", String(SEARCH_VECTOR_DIMENSIONS)], ["encoding", "float32le"]] as const;
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM pix_task_index_meta").get()?.n ?? 0);
  if (count && values.some(([key, value]) => meta.get(key)?.value !== value)) {
    throw new Error("Task embedding identity is incompatible");
  }
  const insert = db.prepare("INSERT INTO pix_task_index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of values) insert.run(key, value);
}

/** Reconcile full current corpus in the existing ACP schema and compute which
 * hashes have not yet been paid for, under the same SQLite writer lock. */
function reconcile(db: SqlDatabase, tasks: readonly CachedTaskCandidate[]): CachedTaskCandidate[] {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS pix_agent_task_live(id TEXT PRIMARY KEY); DELETE FROM pix_agent_task_live");
  const live = db.prepare("INSERT OR IGNORE INTO pix_agent_task_live VALUES(?)");
  const put = db.prepare("INSERT INTO pix_task_documents(task_id,content_hash) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET content_hash=excluded.content_hash WHERE content_hash!=excluded.content_hash");
  for (const task of tasks) {
    live.run(task.id);
    put.run(task.id, taskSemanticHash(task));
  }
  db.exec(`DELETE FROM pix_task_documents WHERE task_id NOT IN (SELECT id FROM pix_agent_task_live);
    DELETE FROM pix_task_vectors WHERE content_hash NOT IN (SELECT content_hash FROM pix_task_documents)`);
  const has = db.prepare("SELECT 1 AS present FROM pix_task_vectors WHERE content_hash=?");
  const seen = new Set<string>();
  return tasks.filter(task => {
    const hash = taskSemanticHash(task);
    if (seen.has(hash) || has.get(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/** Agent tool may fill missing task vectors after an explicit task-search and
 * the user's independent global opt-in. One provider batch per SQL transaction
 * preserves paid work on later failure. Never touches canonical tasks.sqlite. */
export async function indexMissingTaskVectors(root: string, tasks: readonly CachedTaskCandidate[], key: string,
  options: SemanticSearchOptions, signal: AbortSignal): Promise<{ remaining: number; indexed: number }> {
  if (!tasks.length) return { remaining: 0, indexed: 0 };
  const owned = AbortSignal.any([signal, AbortSignal.timeout(TASK_INDEX_DEADLINE_MS)]);
  let remaining = 0, indexed = 0;
  for (let batch = 0; batch <= MAX_NEW_VECTORS_PER_QUERY / BATCH_SIZE; batch++) {
    owned.throwIfAborted();
    if (!(await semanticConsents(options, owned)).tasks) break;
    const response = await withSearchIndexWriter(root, owned, async db => {
      ensureTaskSchema(db);
      const missing = reconcile(db, tasks);
      if (batch === MAX_NEW_VECTORS_PER_QUERY / BATCH_SIZE || missing.length === 0) return { remaining: missing.length, indexed: 0 };
      const targets = missing.slice(0, BATCH_SIZE);
      if (!(await semanticConsents(options, owned)).tasks) throw new Error("Task semantic consent revoked");
      const vectors = await (options.embedTasks ?? embedTaskTexts)(targets.map(taskSemanticText), key, owned);
      owned.throwIfAborted();
      if (!(await semanticConsents(options, owned)).tasks) throw new Error("Task semantic consent revoked");
      if (vectors.length !== targets.length || !vectors.every(validSearchVector)) throw new Error("Invalid task semantic embedding batch");
      const fresh = await freshSemanticCandidates(root, { tasks, sessions: [] }, options, owned);
      if (fresh.tasks.size !== tasks.length) throw new Error("Tasks changed during semantic indexing");
      const add = db.prepare("INSERT INTO pix_task_vectors(content_hash,vector) VALUES(?,?) ON CONFLICT(content_hash) DO NOTHING");
      for (let i = 0; i < targets.length; i++) {
        const bytes = Buffer.alloc(SEARCH_VECTOR_DIMENSIONS * 4);
        vectors[i]!.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        add.run(taskSemanticHash(targets[i]!), bytes);
      }
      return { remaining: missing.length - targets.length, indexed: targets.length };
    });
    indexed += response.indexed;
    remaining = response.remaining;
    if (!remaining || !response.indexed) break;
  }
  return { remaining, indexed };
}

/** Deletion must be reflected in the task cache on an explicit opted-in
 * task search, even if there are no tasks left to embed. Never initialize a
 * fresh index just to record an empty corpus. */
export async function pruneEmptyTaskIndex(root: string, signal: AbortSignal): Promise<void> {
  const filename = join(root, ".pi", "search", "index.sqlite");
  const present = await lstat(filename).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!present) return;
  await withSearchIndexWriter(root, signal, async db => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has("pix_task_index_meta") || !tables.has("pix_task_documents") || !tables.has("pix_task_vectors")) return;
    ensureTaskSchema(db);
    reconcile(db, []);
  });
}
