import { taskSemanticHash, taskSemanticText, type CachedTaskCandidate } from "./semantic-cache.js";
import { embedTaskTexts, requireSemanticIdentity, validSearchVector,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { commitIdentity, type CommitEmbeddingConfig } from "./semantic-commit-provider.js";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import { readSemanticTaskCorpus } from "./semantic-task-corpus.js";

const BATCH_SIZE = 16;

function ensureTaskSchema(db: SqlDatabase, config: CommitEmbeddingConfig): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_task_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_documents(task_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_task_vectors(content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);`);
  const meta = db.prepare("SELECT value FROM pix_task_index_meta WHERE key=?");
  const values = [["identity", commitIdentity(config)], ["model", config.model], ["dimensions", String(config.dimension)], ["encoding", "float32le"]] as const;
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM pix_task_index_meta").get()?.n ?? 0);
  if ((count && values.some(([key, value]) => meta.get(key)?.value !== value))
    || (!count && Number(db.prepare("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n))) {
    throw new Error("Task embedding identity is incompatible");
  }
  const insert = db.prepare("INSERT INTO pix_task_index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of values) insert.run(key, value);
}

/** Reconcile full current corpus in the existing ACP schema and compute which
 * hashes have not yet been paid for, under the same SQLite writer lock. */
async function reconcile(db: SqlDatabase, tasks: readonly CachedTaskCandidate[], signal: AbortSignal): Promise<CachedTaskCandidate[]> {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS pix_agent_task_live(id TEXT PRIMARY KEY); DELETE FROM pix_agent_task_live");
  const live = db.prepare("INSERT OR IGNORE INTO pix_agent_task_live VALUES(?)");
  const put = db.prepare("INSERT INTO pix_task_documents(task_id,content_hash) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET content_hash=excluded.content_hash WHERE content_hash!=excluded.content_hash");
  // Retain paid vectors, including hashes no longer referenced by current tasks.
  const has = db.prepare("SELECT 1 AS present FROM pix_task_vectors WHERE content_hash=?");
  const seen = new Set<string>();
  const missing: CachedTaskCandidate[] = [];
  for (let index = 0; index < tasks.length; index++) {
    if (index % 128 === 0) { signal.throwIfAborted(); await yieldToHost(undefined, { signal }); }
    const task = tasks[index]!;
    const hash = taskSemanticHash(task);
    live.run(task.id);
    put.run(task.id, hash);
    if (seen.has(hash) || has.get(hash)) continue;
    seen.add(hash);
    missing.push(task);
  }
  db.exec("DELETE FROM pix_task_documents WHERE task_id NOT IN (SELECT id FROM pix_agent_task_live)");
  return missing;
}

/** Even a provider that ignores cancellation cannot retain the writer lock or
 * publish a late result after the session that owned it has gone away. */
async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Bootstrap/change catch-up drains the entire backlog in short committed
 * batches. Re-read under ACP's shared writer lock: concurrent hosts never pay
 * twice for a hash, and each batch uses current canonical tasks, not a query's
 * captured candidates. Never writes canonical tasks.sqlite. */
export async function syncSavedTaskVectors(root: string, key: string | undefined,
  options: SemanticSearchOptions, signal: AbortSignal, config: CommitEmbeddingConfig): Promise<{ indexed: number }> {
  let indexed = 0;
  while (true) {
    signal.throwIfAborted();
    await requireSemanticIdentity(options, config, signal);
    // Do not initialize an index just to record a project with no tasks.
    if (!(await readSemanticTaskCorpus(root, signal)).length) {
      if (!await pruneEmptyTaskIndex(root, signal, options, config)) return { indexed };
      // Tasks created while waiting for the shared lock still drain now,
      // without depending on delivery of a later filesystem notification.
    }
    const response = await withSearchIndexWriter(root, signal, async db => {
      await requireSemanticIdentity(options, config, signal);
      const tasks = await readSemanticTaskCorpus(root, signal);
      ensureTaskSchema(db, config);
      const missing = await reconcile(db, tasks, signal);
      if (missing.length === 0) {
        await requireSemanticIdentity(options, config, signal);
        return { remaining: 0, indexed: 0 };
      }
      const targets = missing.slice(0, BATCH_SIZE);
      await requireSemanticIdentity(options, config, signal);
      const vectors = await cancellable((options.embedTasks ?? embedTaskTexts)(targets.map(taskSemanticText), key, signal, config), signal);
      signal.throwIfAborted();
      await requireSemanticIdentity(options, config, signal);
      if (vectors.length !== targets.length || !vectors.every(v => validSearchVector(v, config.dimension))) throw new Error("Invalid task semantic embedding batch");
      const current = await readSemanticTaskCorpus(root, signal);
      const freshHashes = new Set(current.map(taskSemanticHash));
      const add = db.prepare("INSERT INTO pix_task_vectors(content_hash,vector) VALUES(?,?) ON CONFLICT(content_hash) DO NOTHING");
      let added = 0;
      for (let i = 0; i < targets.length; i++) {
        // Never publish the completion of a deleted/edited semantic projection.
        if (!freshHashes.has(taskSemanticHash(targets[i]!))) continue;
        const bytes = Buffer.alloc(config.dimension * 4);
        vectors[i]!.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        add.run(taskSemanticHash(targets[i]!), bytes);
        added++;
      }
      const remaining = (await reconcile(db, current, signal)).length;
      await requireSemanticIdentity(options, config, signal);
      return { remaining, indexed: added };
    });
    indexed += response.indexed;
    if (!response.remaining) return { indexed };
    await yieldToHost(undefined, { signal });
  }
}

/** Deletion must be reflected on a configured background change, even if
 * there are no tasks left to embed. Never initialize a
 * fresh index just to record an empty corpus. */
export async function pruneEmptyTaskIndex(root: string, signal: AbortSignal,
  options: SemanticSearchOptions, config: CommitEmbeddingConfig): Promise<boolean> {
  const filename = join(root, ".pi", "search", "index.sqlite");
  const present = await lstat(filename).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!present) return false;
  return withSearchIndexWriter(root, signal, async db => {
    await requireSemanticIdentity(options, config, signal);
    const tasks = await readSemanticTaskCorpus(root, signal);
    if (tasks.length) return true;
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has("pix_task_index_meta") || !tables.has("pix_task_documents") || !tables.has("pix_task_vectors")) return false;
    ensureTaskSchema(db, config);
    await reconcile(db, tasks, signal);
    await requireSemanticIdentity(options, config, signal);
    return false;
  });
}
