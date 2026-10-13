import { beginWrite, claimWork, openDatabase, safeDirectory, sourceDirectories, sourcePath } from "./source-work.mjs";

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
export interface SourceWriter extends SqlDatabase {
  outside<T>(operation: () => Promise<T>): Promise<T>;
}

/** Durable per-source claim spans planning/HTTP/publication, not a write lock.
 * Publication verifies the claim inside its own short SQLite transaction. */
export async function withSearchIndexWriter<T>(root: string, signal: AbortSignal,
  operation: (db: SourceWriter) => Promise<T>, source: "tasks" | "sessions" | "commits" | "settings" = "sessions", retry = false): Promise<T> {
  signal.throwIfAborted();
  for (const directory of sourceDirectories(root, source)) await safeDirectory(directory);
  const db = await openDatabase(sourcePath(root, source));
  let inTransaction = false, success = false;
  let work: Awaited<ReturnType<typeof claimWork>> | undefined;
  try {
    work = await claimWork(db, signal, { retry });
    await beginWrite(db, signal); inTransaction = true;
    const writer: SourceWriter = {
      exec: sql => db.exec(sql), prepare: sql => db.prepare(sql) as unknown as SqlStatement,
      close: () => { throw new Error("Writer lifetime belongs to source storage"); },
      outside: async operation => {
        work!.network(db);
        db.exec("COMMIT"); inTransaction = false;
        const result = await work!.run(operation);
        await beginWrite(db, signal); inTransaction = true;
        work!.assert(db);
        return result;
      },
    };
    const result = await operation(writer);
    work.assert(db);
    db.exec("COMMIT"); inTransaction = false; success = true;
    return result;
  } finally {
    if (inTransaction) { try { db.exec("ROLLBACK"); } catch {} }
    if (work) { try { await work.release(success); } catch { /* Bounded expiry recovers ownership. */ } }
    db.close();
  }
}
