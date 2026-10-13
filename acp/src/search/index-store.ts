import { lstat, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay, setImmediate as yieldTask } from "node:timers/promises";
import { hashText, type SearchDocument } from "./documents.js";
import { EMBEDDING_DIMENSIONS, validVector } from "./embeddings.js";
import { canonicalSearchIndexPath } from "./canonical-index.js";
import { createSessionIndexTransaction, loadSessionTitleVectors, type SessionIndexTransaction, type StoredSessionVector } from "./session-index.js";
import { readSessionBoundaryState, reconcileSessionBoundaries, sessionBoundaryHits,
  type SessionBoundaryRow, type SessionBoundaryState } from "./session-boundary-index.js";
import type { SessionSearchHit } from "./contract.js";
import { verifySessionBoundaryIndexPath } from "./session-boundary-paths.js";
import { readTaskVectors, taskIndexTransaction, type TaskIndexTransaction } from "./task-index.js";
import type { SemanticEmbeddingConfig } from "./config.js";
import { compatibleEmbeddingMetadata, embeddingMetadata, SearchCacheCompatibilityError } from "./embedding-cache.js";
import { beginWrite, claimWork, safeDirectory, safeFile, sourceDirectories } from "./source-work.js";
import { importLegacySettings } from "./settings-migration.js";

const VERSION = "2";
export interface CachedIndex { vectors: Map<string, number[]>; hashes: Record<string, readonly string[]> }
export const emptyIndex = (): CachedIndex => ({ vectors: new Map(), hashes: {} });
async function loadConnection(connection: DatabaseSync, signal: AbortSignal, dimension = EMBEDDING_DIMENSIONS,
  documents?: readonly SearchDocument[]): Promise<CachedIndex> {
  const cache = emptyIndex(); let n = 0;
  const get = connection.prepare("SELECT hash,vector FROM vectors WHERE hash=?");
  const hashes = documents && new Set(documents.flatMap(document => document.chunks.map(hashText)));
  const rows = hashes ? (function* () { for (const hash of hashes) { const row = get.get(hash); if (row) yield row; } })()
    : connection.prepare("SELECT hash,vector FROM vectors").iterate();
  for (const row of rows) {
    signal.throwIfAborted();
    if (typeof row.hash === "string" && row.vector instanceof Uint8Array && row.vector.byteLength === dimension * 4) {
      const buffer = Buffer.from(row.vector);
      const vector = Array.from({ length: dimension }, (_, i) => buffer.readFloatLE(i * 4));
      if (validVector(vector, dimension)) cache.vectors.set(row.hash, vector);
    }
    if (++n % 32 === 0) await yieldTask();
  }
  if (documents) {
    for (const document of documents) cache.hashes[document.hit.id] = document.chunks.map(hashText);
    return cache;
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
  outside<T>(operation: () => Promise<T>): Promise<T>;
  load(documents?: readonly SearchDocument[]): Promise<CachedIndex>;
  save(documents: readonly SearchDocument[], vectors: ReadonlyMap<string, number[]>): Promise<void>;
  sessionTitles(): SessionIndexTransaction;
  sessionBoundaries(live: readonly string[], updates: readonly SessionBoundaryRow[]): void;
  tasks(): TaskIndexTransaction;
}
/** Source-owned durable databases. Settings is shared across projects. */
export class SearchIndexStore {
  constructor(private readonly retryBudgetMs = 600) {}
  path(cwd: string, source: "settings" | "sessions" | "tasks" = "settings"): string { return canonicalSearchIndexPath(cwd, source); }
  /** Read-only snapshot for restart/query visibility; never discovers sources or calls a provider. */
  async read(cwd: string, signal: AbortSignal, config?: SemanticEmbeddingConfig, documents?: readonly SearchDocument[]): Promise<CachedIndex> {
    const path = this.path(cwd);
    for (const directory of sourceDirectories(cwd, "settings")) {
      const info = await lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (!info) return emptyIndex();
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search directory");
    }
    await safeFile(path);
    try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex(); throw error; }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5; BEGIN");
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='documents'").get()) return emptyIndex();
      const cache = await loadConnection(db, signal, config?.dimension, documents);
      const get = db.prepare("SELECT value FROM metadata WHERE key=?");
      if (get.get("schema")?.value !== VERSION) throw new Error("Incompatible search index schema");
      if (!compatibleEmbeddingMetadata(db, "metadata", config)) cache.vectors.clear();
      return cache;
    } finally { db.close(); }
  }

  /** Read the separately namespaced session vectors without changing settings state. */
  async readSessionTitles(cwd: string, signal: AbortSignal, config?: SemanticEmbeddingConfig): Promise<Map<string, StoredSessionVector>> {
    const path = this.path(cwd, "sessions");
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try { return await loadSessionTitleVectors(db, signal, config); }
    finally { db.close(); }
  }

  /** Task vectors occupy their own source database.
   * Returning no vectors when absent does not create the namespace. */
  async readTaskVectors(cwd: string, signal: AbortSignal, config?: SemanticEmbeddingConfig): Promise<Map<string, number[]>> {
    const filename = this.path(cwd, "tasks");
    try { await stat(filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return await readTaskVectors(db, signal, config); }
    finally { db.close(); }
  }

  async readSessionBoundaryState(cwd: string, signal: AbortSignal): Promise<Map<string, SessionBoundaryState>> {
    await verifySessionBoundaryIndexPath(cwd);
    const path = this.path(cwd, "sessions");
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try { return await readSessionBoundaryState(db, signal); }
    finally { db.close(); }
  }

  async searchSessionBoundaries(cwd: string, query: string, signal: AbortSignal): Promise<SessionSearchHit[]> {
    await verifySessionBoundaryIndexPath(cwd);
    const path = this.path(cwd, "sessions");
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(path, { readOnly: true });
    try { return sessionBoundaryHits(db, query, signal); }
    finally { db.close(); }
  }

  /** A durable source claim coordinates paid work across processes. outside() releases
   * the planning transaction before HTTP, then fences publication in a fresh write
   * transaction. Other sources use independent queues and SQLite files.
   */
  async write<T>(cwd: string, signal: AbortSignal, operation: (tx: IndexTransaction) => Promise<T>, config?: SemanticEmbeddingConfig,
    options: { acquisitionTimeoutMs?: number; source?: "settings" | "sessions" | "tasks"; retry?: boolean } = {}): Promise<T> {
    const dimension = config?.dimension ?? EMBEDDING_DIMENSIONS;
    const source = options.source ?? "settings";
    const path = this.path(cwd, source);
    const acquisition = new AbortController();
    const timer = setTimeout(() => acquisition.abort(), options.acquisitionTimeoutMs ?? this.retryBudgetMs);
    const bounded = AbortSignal.any([signal, acquisition.signal]);
    const previous = queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>(r => { release = r; });
    const tail = previous.catch(() => {}).then(() => owned);
    queues.set(path, tail);
    let db: DatabaseSync | undefined;
    let transaction = false;
    let work: Awaited<ReturnType<typeof claimWork>> | undefined;
    let success = false;
    try {
      // Even cancelled waiters remain in the chain until their predecessor finishes.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) { bounded.removeEventListener("abort", abort); reject(bounded.reason); return; }
        previous.then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
      });
      bounded.throwIfAborted();
      for (const directory of sourceDirectories(cwd, source)) await safeDirectory(directory);
      await safeFile(path);
      bounded.throwIfAborted();
      db = new DatabaseSync(path);
      clearTimeout(timer);
      work = await claimWork(db, signal, { retry: options.retry });
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
      const metadata = { schema: VERSION, ...embeddingMetadata(config) };
      const get = db.prepare("SELECT value FROM metadata WHERE key=?");
      const schema = get.get("schema")?.value;
      if (schema && schema !== VERSION) throw new Error("Incompatible search index schema");
      const hasIdentity = get.get("model") !== undefined;
      const incompatibleSettings = config !== undefined && !compatibleEmbeddingMetadata(db, "metadata", config)
        && Number(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()?.n) > 0;
      const checkSettings = () => { if (incompatibleSettings) throw new SearchCacheCompatibilityError(); };
      const set = db.prepare("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      // Local FTS writes must not downgrade or overwrite a configured embedding identity.
      // Other namespaces may write while an incompatible settings cache is retained.
      for (const [key, value] of Object.entries(metadata)) {
        if (key === "schema" || (!incompatibleSettings && (config || !hasIdentity))) set.run(key, value);
      }
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
      if (source === "settings") {
        checkSettings();
        await importLegacySettings(connection, cwd, signal, config);
      }
      const check = () => signal.throwIfAborted();
      const tx: IndexTransaction = {
        outside: async operation => {
          work!.network(connection);
          connection.exec("COMMIT"); transaction = false;
          const result = await work!.run(operation);
          await beginWrite(connection, signal);
          transaction = true;
          work!.assert(connection);
          return result;
        },
        sessionTitles: () => createSessionIndexTransaction(connection, signal, config),
        sessionBoundaries: (live, updates) => reconcileSessionBoundaries(connection, signal, live, updates),
        tasks: () => taskIndexTransaction(connection, config),
        load: documents => { checkSettings(); return loadConnection(connection, signal, dimension, documents); },
        save: async (documents, vectors) => {
          checkSettings();
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
              if (vector && validVector(vector, dimension)) {
                const buffer = Buffer.alloc(dimension * 4);
                vector.forEach((v, i) => buffer.writeFloatLE(v, i * 4));
                vectorSet.run(hash, buffer);
              }
              if (++n % 32 === 0) await yieldTask();
            }
            if (++n % 32 === 0) await yieldTask();
          }
          // Other windows/app versions may still use an older authored catalogue.
          // Query and index planning select only the caller's content hashes.
          if (source !== "settings") connection.exec("DELETE FROM documents WHERE id NOT IN (SELECT id FROM live_documents); DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM live_hashes)");
          check();
        },
      };
      const result = await operation(tx);
      check();
      work.assert(db);
      db.exec("COMMIT");
      transaction = false;
      success = true;
      return result;
    } catch (error) {
      if (!signal.aborted && ((!transaction && bounded.aborted) || busy(error))) throw new SearchIndexBusyError();
      throw error;
    } finally {
      clearTimeout(timer);
      if (transaction) { try { db?.exec("ROLLBACK"); } catch {} }
      if (work) { try { await work.release(success); } catch { /* Expiry preserves crash recovery. */ } }
      db?.close();
      release();
      void tail.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
    }
  }
}
