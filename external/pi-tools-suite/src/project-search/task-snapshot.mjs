import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const MAX_BYTES = 64 * 1024 * 1024;
const TASK_SCHEMA = "CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0)";
const normalize = sql => sql.replace(/[\s;"`\[\]]/g, "").toLowerCase();

/** A bounded, read-only logical snapshot. Physical WAL/checkpoint changes and
 * board positions are not searchable task changes. Never use immutable mode:
 * committed rows may still live in the WAL. */
export async function taskSnapshot(filename, signal) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    signal.throwIfAborted();
    const file = filename + suffix;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || (!suffix && info.nlink !== 1)
        || info.size > MAX_BYTES || await realpath(file) !== file) throw new Error("Unsafe or oversized task store");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!suffix) return "absent";
    }
  }
  let db;
  if ("Bun" in globalThis) {
    const { Database } = await import("bun:sqlite");
    db = new Database(filename, { readonly: true });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename, { readOnly: true });
  }
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) throw new Error("Unsupported task store");
    const table = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='tasks'").get();
    if (table?.type !== "table" || normalize(table.sql) !== normalize(TASK_SCHEMA)) throw new Error("Invalid tasks table");
    const digest = createHash("sha256").update("tasks-logical-v1\n");
    let count = 0, bytes = 0;
    for (const row of db.prepare("SELECT id,payload,revision FROM tasks ORDER BY id LIMIT 10001").iterate()) {
      signal.throwIfAborted();
      if (++count > 10000 || typeof row.id !== "string" || typeof row.payload !== "string"
        || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid task row");
      const size = Buffer.byteLength(row.payload);
      if (size > 1024 * 1024 || (bytes += size) > MAX_BYTES) throw new Error("Task snapshot bound");
      digest.update(JSON.stringify([row.id, row.payload, row.revision]) + "\n");
    }
    signal.throwIfAborted();
    return digest.digest("hex");
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

const MAX_PLANS = 500;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_TOTAL = 32 * 1024 * 1024;

/** Canonical saved plans (.pi/plans/**\/*.md) indexed with the task source.
 * Bounded and deterministic: symlinks, non-files and oversized files are
 * skipped, never followed; entries are sorted so every reader agrees. */
export async function readPlanFiles(root, signal) {
  const base = path.join(root, ".pi", "plans");
  for (const dir of [path.join(root, ".pi"), base]) {
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return [];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  const plans = [];
  let total = 0;
  const walk = async directory => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      signal.throwIfAborted();
      if (plans.length >= MAX_PLANS) return;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      let handle;
      try { handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") continue; throw error; }
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_PLAN_BYTES || total + info.size > MAX_PLAN_TOTAL) continue;
        total += info.size;
        const content = await handle.readFile("utf8");
        plans.push({ path: path.relative(root, full).split(path.sep).join("/"), content });
      } finally { await handle.close(); }
    }
  };
  await walk(base);
  return plans;
}

/** Logical revision of the task search source: canonical tasks plus saved
 * plans. Without plans it equals taskSnapshot() so prior coverage survives. */
export async function taskSourceRevision(root, signal) {
  const tasks = await taskSnapshot(path.join(root, ".pi", "tasks.sqlite"), signal);
  const plans = await readPlanFiles(root, signal);
  if (!plans.length) return tasks;
  const digest = createHash("sha256").update("tasks-plans-logical-v1\n").update(tasks + "\n");
  for (const plan of plans) digest.update(JSON.stringify([plan.path, createHash("sha256").update(plan.content).digest("hex")]) + "\n");
  return digest.digest("hex");
}
