import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay, setImmediate as yieldTask } from "node:timers/promises";
import { SEARCH_EMBEDDING_MODEL } from "./contract.js";
import { hashText, type SearchDocument } from "./documents.js";
import { EMBEDDING_DIMENSIONS, validVector } from "./embeddings.js";
import { canonicalSearchIndexPath } from "./canonical-index.js";
import { createSessionIndexTransaction, loadSessionTitleVectors, type SessionIndexTransaction, type StoredSessionVector } from "./session-index.js";

const VERSION = "2";
export interface CachedIndex { vectors: Map<string, number[]>; hashes: Record<string, readonly string[]> }
export const emptyIndex = (): CachedIndex => ({ vectors: new Map(), hashes: {} });
async function loadConnection(connection: DatabaseSync, signal: AbortSignal): Promise<CachedIndex> {
  const cache = emptyIndex(); let n = 0;
  for (const row of connection.prepare("SELECT hash,vector FROM vectors").iterate()) {
    signal.throwIfAborted();
    if (typeof row.hash === "string" && row.vector instanceof Uint8Array && row.vector.byteLength === EMBEDDING_DIMENSIONS * 4) {
      const buffer = Buffer.from(row.vector);
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => buffer.readFloatLE(i * 4));
      if (validVector(vector)) cache.vectors.set(row.hash, vector);
    }
    if (++n % 32 === 0) await yieldTask();
  }
  for (const row of connection.prepare("SELECT id,hashes FROM documents").iterate()) {
    signal.throwIfAborted();
    if (typeof row.id === "string" && typeof row.hashes === "string") {
      const hashes: unknown = JSON.parse(row.hashes);
      if (Array.isArray(hashes) && hashes.every(hash => typeof hash === "string")) cache.hashes[row.id] = hashes;
    }
    if (++n % 32 === 0) await yieldTask();
  }
  return cache;
}
export class SearchIndexBusyError extends Error {
  constructor() { super("Search index busy; update deferred"); }
}
const queues = new Map<string, Promise<void>>();
function busy(error: unknown): boolean {
  return error instanceof Error && /database (?:is )?(?:locked|busy)/i.test(error.message);
}
export interface IndexTransaction {
  load(): Promise<CachedIndex>;
  save(documents: readonly SearchDocument[], vectors: ReadonlyMap<string, number[]>): Promise<void>;
  sessionTitles(): SessionIndexTransaction;
}
/** Project-owned durable database. No reset, rename, unlink or cache-directory override. */
export class SearchIndexStore {
  constructor(private readonly retryBudgetMs = 600) {}
  path(cwd: string): string { return canonicalSearchIndexPath(cwd); }
  /** Read-only snapshot for restart/query visibility; never discovers sources or calls a provider. */
  async read(cwd: string, signal: AbortSignal): Promise<CachedIndex> {
    const path = this.path(cwd);
    try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex(); throw error; }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5; BEGIN");
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='documents'").get()) return emptyIndex();
      const cache = await loadConnection(db, signal);
      const get = db.prepare("SELECT value FROM metadata WHERE key=?");
      if (get.get("schema")?.value !== VERSION) throw new Error("Incompatible search index schema");
      if (get.get("model")?.value !== SEARCH_EMBEDDING_MODEL || get.get("dimensions")?.value !== String(EMBEDDING_DIMENSIONS)
        || get.get("encoding")?.value !== "float32le") cache.vectors.clear();
      return cache;
    } finally { db.close(); }
  }

  /** Read the separately namespaced session vectors without changing settings state. */
  async readSessionTitles(cwd: string, signal: AbortSignal): Promise<Map<string, StoredSessionVector>> {
    const path = this.path(cwd);
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try { return await loadSessionTitleVectors(db, signal); }
    finally { db.close(); }
  }

  /** Queue and SQLite lock are acquired BEFORE paying for settings embeddings.
   * BEGIN IMMEDIATE remains owned across a bounded embedding batch, so another process
   * reloads our committed hashes instead of duplicating that batch. SQLite is authoritative;
   * no stale in-memory corpus is allowed to replace another writer's reconciliation.
   */
  async write<T>(cwd: string, signal: AbortSignal, operation: (tx: IndexTransaction) => Promise<T>): Promise<T> {
    const path = this.path(cwd);
    const acquisition = new AbortController();
    const timer = setTimeout(() => acquisition.abort(), this.retryBudgetMs);
    const bounded = AbortSignal.any([signal, acquisition.signal]);
    const previous = queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>(r => { release = r; });
    const tail = previous.catch(() => {}).then(() => owned);
    queues.set(path, tail);
    let db: DatabaseSync | undefined;
    let transaction = false;
    try {
      // Even cancelled waiters remain in the chain until their predecessor finishes.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) { bounded.removeEventListener("abort", abort); reject(bounded.reason); return; }
        previous.then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
      });
      bounded.throwIfAborted();
      await mkdir(join(resolve(cwd), ".pi", "search"), { recursive: true, mode: 0o700 });
      bounded.throwIfAborted();
      db = new DatabaseSync(path);
      // Keep main-thread stalls tiny; all longer waits happen in cancellable async timers.
      db.exec("PRAGMA busy_timeout=5");
      while (true) {
        bounded.throwIfAborted();
        try {
          db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
          transaction = true;
          clearTimeout(timer);
          break;
        } catch (error) {
          if (!busy(error)) throw error;
          await delay(25, undefined, { signal: bounded });
        }
      }
      // The queue budget bounds acquisition, not owned work. Provider work has its own timeout.
      signal.throwIfAborted();
      db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, text TEXT NOT NULL, hit TEXT NOT NULL, hashes TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vectors (hash TEXT PRIMARY KEY, vector BLOB NOT NULL);
        CREATE TEMP TABLE live_documents (id TEXT PRIMARY KEY);
        CREATE TEMP TABLE live_hashes (hash TEXT PRIMARY KEY);`);
      const metadata = { schema: VERSION, model: SEARCH_EMBEDDING_MODEL, dimensions: String(EMBEDDING_DIMENSIONS), encoding: "float32le" };
      const get = db.prepare("SELECT value FROM metadata WHERE key=?");
      const schema = get.get("schema")?.value;
      if (schema && schema !== "1" && schema !== VERSION) throw new Error("Incompatible search index schema");
      // Schema 2 fences old body-index writers and retains only settings-owned data.
      db.exec("PRAGMA secure_delete=ON; DELETE FROM documents WHERE json_extract(hit, '$.kind') IS NOT 'settings'; DROP TABLE IF EXISTS filter_decisions");
      const retainHash = db.prepare("INSERT OR IGNORE INTO live_hashes VALUES (?)");
      let retained = 0;
      for (const row of db.prepare("SELECT hashes FROM documents").iterate()) {
        signal.throwIfAborted();
        const hashes: unknown = typeof row.hashes === "string" ? JSON.parse(row.hashes) : [];
        if (!Array.isArray(hashes) || !hashes.every(hash => typeof hash === "string")) throw new Error("Invalid search index hashes");
        for (const hash of hashes) retainHash.run(hash);
        if (++retained % 32 === 0) await yieldTask();
      }
      db.exec("DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM live_hashes)");
      if (["model", "dimensions", "encoding"].some(key => get.get(key)?.value !== metadata[key as keyof typeof metadata])) db.exec("DELETE FROM vectors");
      const set = db.prepare("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      for (const [key, value] of Object.entries(metadata)) set.run(key, value);
      // Older ACP processes may still be alive with a draft. Fence their schema reset transaction.
      db.exec(`CREATE TRIGGER IF NOT EXISTS settings_schema_update BEFORE UPDATE ON metadata
        WHEN NEW.key='schema' AND NEW.value!='2' BEGIN SELECT RAISE(ABORT, 'Search index requires session-title search'); END;
        CREATE TRIGGER IF NOT EXISTS settings_schema_insert BEFORE INSERT ON metadata
        WHEN NEW.key='schema' AND NEW.value!='2' BEGIN SELECT RAISE(ABORT, 'Search index requires session-title search'); END;
        CREATE TRIGGER IF NOT EXISTS settings_document_insert BEFORE INSERT ON documents
        WHEN json_extract(NEW.hit, '$.kind') IS NOT 'settings' BEGIN SELECT RAISE(ABORT, 'Only settings may be indexed'); END;
        CREATE TRIGGER IF NOT EXISTS settings_document_update BEFORE UPDATE ON documents
        WHEN json_extract(NEW.hit, '$.kind') IS NOT 'settings' BEGIN SELECT RAISE(ABORT, 'Only settings may be indexed'); END;`);
      const connection = db;
      const check = () => signal.throwIfAborted();
      const tx: IndexTransaction = {
        sessionTitles: () => createSessionIndexTransaction(connection, signal),
        load: () => loadConnection(connection, signal),
        save: async (documents, vectors) => {
          const upsert = connection.prepare("INSERT INTO documents VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,hit=excluded.hit,hashes=excluded.hashes WHERE documents.text!=excluded.text OR documents.hit!=excluded.hit OR documents.hashes!=excluded.hashes");
          const documentLive = connection.prepare("INSERT OR IGNORE INTO live_documents VALUES (?)");
          const hashLive = connection.prepare("INSERT OR IGNORE INTO live_hashes VALUES (?)");
          const vectorSet = connection.prepare("INSERT INTO vectors VALUES (?,?) ON CONFLICT(hash) DO NOTHING");
          connection.exec("DELETE FROM live_documents; DELETE FROM live_hashes");
          let n = 0;
          for (const document of documents) {
            check();
            if (document.hit.kind !== "settings") throw new Error("Only settings may be indexed");
            const hashes = document.chunks.map(hashText);
            upsert.run(document.hit.id, document.text, JSON.stringify(document.hit), JSON.stringify(hashes));
            documentLive.run(document.hit.id);
            for (const hash of hashes) {
              hashLive.run(hash);
              const vector = vectors.get(hash);
              if (vector && validVector(vector)) {
                const buffer = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
                vector.forEach((v, i) => buffer.writeFloatLE(v, i * 4));
                vectorSet.run(hash, buffer);
              }
              if (++n % 32 === 0) await yieldTask();
            }
            if (++n % 32 === 0) await yieldTask();
          }
          connection.exec("DELETE FROM documents WHERE id NOT IN (SELECT id FROM live_documents); DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM live_hashes)");
          check();
        },
      };
      const result = await operation(tx);
      check();
      db.exec("COMMIT");
      transaction = false;
      return result;
    } catch (error) {
      if (!signal.aborted && ((!transaction && bounded.aborted) || busy(error))) throw new SearchIndexBusyError();
      throw error;
    } finally {
      clearTimeout(timer);
      if (transaction) { try { db?.exec("ROLLBACK"); } catch {} }
      db?.close();
      release();
      void tail.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
    }
  }
}
