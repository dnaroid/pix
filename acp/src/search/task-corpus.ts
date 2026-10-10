import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { openTaskDatabase } from "../registry/task-database.js";
import { hashText } from "./documents.js";
import type { TaskSemanticDocument } from "./task-index.js";

const MAX_TASKS = 10_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const TYPES = new Set(["bug", "feature", "improvement", "idea"]);
const STATUSES = new Set(["backlog", "todo", "in-progress", "done", "failed"]);
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

type References = { parentId?: string; relatedTaskIds?: string[] };

function validateReferences(references: ReadonlyMap<string, References>): void {
  const validated = new Set<string>();
  for (const [id, source] of references) {
    if (source.relatedTaskIds?.some(related => !references.has(related))) {
      throw new Error("Invalid task semantic payload: missing related task");
    }
    let current: string | undefined = id;
    const visiting = new Set<string>();
    while (current && !validated.has(current)) {
      if (!references.has(current)) throw new Error("Invalid task semantic payload: missing parent task");
      if (visiting.has(current)) throw new Error("Invalid task semantic payload: cyclic parent task");
      visiting.add(current);
      current = references.get(current)?.parentId;
    }
    for (const seen of visiting) validated.add(seen);
  }
}

/** An intentionally narrow semantic projection: ONLY title+description are
 * eligible for provider upload. Paths, status, other-task text, links, models,
 * session IDs and attachment metadata/bytes are not part of embedding input. */
export async function readTaskSemanticCorpus(cwd: string, signal: AbortSignal): Promise<TaskSemanticDocument[]> {
  signal.throwIfAborted();
  const filename = join(cwd, ".pi", "tasks.sqlite");
  try {
    const file = await lstat(filename);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("Unsafe task database");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const db = await openTaskDatabase(filename);
  try {
    db.exec("BEGIN");
    try {
      // Bound the snapshot BEFORE allocating all task payload strings.
      const budget = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) AS bytes FROM tasks").get();
      const count = Number(budget?.count ?? 0);
      if (!Number.isSafeInteger(count) || count > MAX_TASKS || Number(budget?.bytes) > MAX_SNAPSHOT_BYTES) {
        throw new Error("Task semantic index exceeds size limit");
      }
      const docs: TaskSemanticDocument[] = [];
      const references = new Map<string, References>();
      for (const row of db.prepare("SELECT id,payload FROM tasks ORDER BY position,id").iterate()) {
        signal.throwIfAborted();
        if (typeof row.id !== "string" || !row.id || typeof row.payload !== "string"
          || Buffer.byteLength(row.payload) > 1024 * 1024) throw new Error("Invalid task payload size");
        const value: unknown = JSON.parse(row.payload);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task payload");
        const task = value as Record<string, unknown>;
        if (task.id !== row.id || row.id.length > 128 || typeof task.title !== "string" || task.title.length > 200
          || !TYPES.has(task.type as string) || !STATUSES.has(task.status as string) || !PRIORITIES.has(task.priority as string)
          || typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt))
          || typeof task.updatedAt !== "string" || !Number.isFinite(Date.parse(task.updatedAt))
          || (task.description !== undefined && (typeof task.description !== "string" || task.description.length > 10_000))) {
          throw new Error("Invalid task semantic payload");
        }
        if (task.parentId !== undefined && (typeof task.parentId !== "string" || !task.parentId || task.parentId.length > 128)) {
          throw new Error("Invalid task semantic parent id");
        }
        if (task.epic !== undefined && typeof task.epic !== "boolean") throw new Error("Invalid task epic flag");
        if (task.epic && task.parentId) throw new Error("Epic task cannot have a parent");
        if (task.relatedTaskIds !== undefined && (!Array.isArray(task.relatedTaskIds)
          || task.relatedTaskIds.length > 50 || task.relatedTaskIds.some(id => typeof id !== "string" || !id || id.length > 128 || id === row.id)
          || new Set(task.relatedTaskIds).size !== task.relatedTaskIds.length)) {
          throw new Error("Invalid task semantic related-task IDs");
        }
        references.set(row.id, {
          ...(typeof task.parentId === "string" ? { parentId: task.parentId } : {}),
          ...(Array.isArray(task.relatedTaskIds) ? { relatedTaskIds: task.relatedTaskIds as string[] } : {}),
        });
        const title = task.title.trim();
        const description = (task.description as string | undefined)?.trim() ?? "";
        if (!title && !description) throw new Error("Invalid empty task content");
        const text = `Task title: ${title}\nTask description: ${description}`.slice(0, 2000);
        docs.push({ id: row.id, title: title || description.split("\n").find(Boolean)?.slice(0, 200) || "Untitled task",
          snippet: description.slice(0, 320), text, hash: hashText(text) });
      }
      validateReferences(references);
      db.exec("COMMIT");
      return docs;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
