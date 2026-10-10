import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface SqlStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
}
export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const MAX_INDEX_BYTES = 512 * 1024 * 1024;
// A Desktop or TUI writer may hold BEGIN IMMEDIATE during an outbound
// 9-second embedding batch. Do not give up on another selected source after
// only a few seconds; the caller's shorter indexing/deadline AbortSignal
// still bounds the wait and cancellation releases ownership.
const SQLITE_LOCK_WAIT_MS = 35_000;

/** Existing Desktop uses SQLite BEGIN IMMEDIATE during embedding calls.
 * Use that same lock to avoid double-billing across TUI/Desktop processes.
 * Never use a bespoke process lock, delete a database, or replace a WAL file.
 */
export async function withSearchIndexWriter<T>(root: string, signal: AbortSignal,
  operation: (db: SqlDatabase) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const pi = join(root, ".pi");
  try { await mkdir(pi, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const piStat = await lstat(pi);
  if (!piStat.isDirectory() || piStat.isSymbolicLink()) throw new Error("Unsafe project storage");
  const dir = join(pi, "search");
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("Unsafe search index directory");
  const filename = join(dir, "index.sqlite");
  const created = await open(filename, "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  });
  await created?.close();
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_INDEX_BYTES) {
    throw new Error("Unsafe project search index");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await lstat(filename + suffix).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink > 1)) {
      throw new Error("Unsafe search index sidecar");
    }
  }
  let db: SqlDatabase;
  if ("Bun" in globalThis) {
    const driver = "bun:sqlite";
    const { Database } = await import(driver);
    db = new Database(filename, { readwrite: true, create: false }) as unknown as SqlDatabase;
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename, { readOnly: false }) as unknown as SqlDatabase;
  }
  let inTransaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5");
    const until = Date.now() + SQLITE_LOCK_WAIT_MS;
    while (true) {
      signal.throwIfAborted();
      try {
        db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
        inTransaction = true;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/locked|busy/i.test(error.message) || Date.now() >= until) {
          throw error;
        }
        await delay(30, undefined, { signal });
      }
    }
    const result = await operation(db);
    signal.throwIfAborted();
    db.exec("COMMIT");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) { try { db.exec("ROLLBACK"); } catch { /* Preserve original error. */ } }
    throw error;
  } finally { db.close(); }
}
