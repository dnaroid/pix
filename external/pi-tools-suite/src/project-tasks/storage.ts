import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { MAX_TASK_BYTES, validateTaskDocument, type ProjectTask, type TaskDocument } from "./schema.js";

interface Statement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint };
}
export interface TaskDatabase { exec(sql: string): unknown; prepare(sql: string): Statement; close(): void }
export interface TaskSnapshot { document: TaskDocument; revisions: Map<string, number> }
export interface ProjectTasksServices { beforeCommit?: () => Promise<void> }
export interface TaskAttachment { hash: string; name: string; size: number }

/** An unlink-in-progress SQLite sidecar may stat with nlink=0 (not a hard
 * link). Keep rejecting >1 as a real external hard-link alias. Main DB and
 * immutable attachment files still require nlink===1. */
export const safeSqliteSidecarNlink = (nlink: number): boolean => nlink === 0 || nlink === 1;
const schema = [
  "CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE attachments (hash TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL)",
  "CREATE TABLE task_attachments (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES attachments(hash), ordinal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,hash))",
];
const normalize = (sql: string) => sql.replace(/[\s;"`\[\]]/g, "").toLowerCase();

export async function safeDirectory(folder: string, create = false): Promise<boolean> {
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe task storage directory: ${folder}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
    try { await mkdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return safeDirectory(folder);
  }
}

/** Each operation owns a short-lived connection; reads never create storage. */
export async function withTaskDatabase<T>(folder: string, mode: "read" | "write" | "create", fn: (db: TaskDatabase | undefined) => T): Promise<T> {
  if (!await safeDirectory(folder, mode === "create")) return fn(undefined);
  const filename = path.join(folder, "tasks.sqlite");
  let fresh = false;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe task database: expected a regular single-link file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (mode !== "create") return fn(undefined);
    try {
      const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.close(); fresh = true;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const info = await lstat(filename + suffix);
      if (!info.isFile() || info.isSymbolicLink() || !safeSqliteSidecarNlink(info.nlink)) throw new Error(`Unsafe task database sidecar: ${suffix}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let db: TaskDatabase;
  if ("Bun" in globalThis) {
    const bunSqlite = "bun:sqlite";
    const { Database } = await import(bunSqlite);
    db = new Database(filename, mode === "read" ? { readonly: true } : { readwrite: true, create: false }) as unknown as TaskDatabase;
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename, { readOnly: mode === "read" }) as unknown as TaskDatabase;
  }
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (fresh) {
      db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;");
      try { for (const sql of schema) db.exec(sql); db.exec("PRAGMA user_version=1; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1) throw new Error(`Unsupported task database user_version: ${version}`);
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== schema.length || schema.some(sql => !tables.some(row => normalize(String(row.sql)) === normalize(sql)))) throw new Error("Invalid task database schema");
    if (mode !== "read") db.exec("PRAGMA journal_mode=WAL");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw new Error("Task database must use WAL");
    return fn(db);
  } finally { db.close(); }
}

export async function readTaskStore(folder: string, signal?: AbortSignal): Promise<TaskSnapshot> {
  signal?.throwIfAborted();
  return withTaskDatabase(folder, "read", db => {
    const revisions = new Map<string, number>();
    const tasks = (db?.prepare("SELECT id,payload,revision,position FROM tasks ORDER BY position ASC,id ASC").all() ?? []).map(row => {
      if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_TASK_BYTES) throw new Error("Invalid task payload size");
      const task = validateTaskDocument({ version: 1, tasks: [JSON.parse(row.payload)] }, false).tasks[0]!;
      if (row.id !== task.id || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Number.isSafeInteger(row.position)) throw new Error("Invalid task database row");
      revisions.set(task.id, Number(row.revision)); return task;
    });
    return { document: validateTaskDocument({ version: 1, tasks }), revisions };
  });
}
export function transaction<T>(db: TaskDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function checkChange(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new Error("Task changed during update; retry without overwriting external changes");
}
export async function writeTaskRecord(folder: string, snapshot: TaskSnapshot, record: ProjectTask | { id: string; deleted: true }, signal?: AbortSignal, services?: ProjectTasksServices): Promise<void> {
  const deleted = "deleted" in record;
  if (!deleted) validateTaskDocument({ version: 1, tasks: [record] }, false);
  const payload = JSON.stringify(record);
  if (Buffer.byteLength(payload) > MAX_TASK_BYTES) throw new Error("Task payload exceeds the 1 MiB limit");
  const revision = snapshot.revisions.get(record.id);
  await services?.beforeCommit?.(); signal?.throwIfAborted();
  await withTaskDatabase(folder, revision === undefined && !deleted ? "create" : "write", db => {
    if (!db) throw new Error("Task database missing; retry");
    transaction(db, () => {
      if (deleted) checkChange(db.prepare("DELETE FROM tasks WHERE id=? AND revision=?").run(record.id, revision).changes);
      else if (revision !== undefined) checkChange(db.prepare("UPDATE tasks SET payload=?,revision=revision+1 WHERE id=? AND revision=?").run(payload, record.id, revision).changes);
      else {
        if (Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count) >= 10000) throw new Error("Expected at most 10,000 tasks");
        db.prepare("INSERT INTO tasks(id,payload,position) VALUES(?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM tasks))").run(record.id, payload);
      }
      // Validate the committed candidate set under the same SQLite writer lock:
      // no dangling parents, self-references, or cycles, even during a delete.
      const candidate = db.prepare("SELECT payload FROM tasks").all().map(row => JSON.parse(String(row.payload)));
      validateTaskDocument({ version: 1, tasks: candidate });
    });
  });
}
export async function readAttachments(folder: string, id: string): Promise<TaskAttachment[]> {
  return withTaskDatabase(folder, "read", db => (db?.prepare("SELECT a.hash,a.name,a.size FROM attachments a JOIN task_attachments t ON t.hash=a.hash WHERE t.task_id=? ORDER BY t.ordinal ASC,a.hash ASC").all(id) ?? []) as unknown as TaskAttachment[]);
}
