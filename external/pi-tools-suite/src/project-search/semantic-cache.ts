import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withTaskDatabase } from "../project-tasks/storage.js";
import { validSearchVector, type SemanticSearchOptions } from "./semantic-provider.js";
import { commitIdentity, type CommitEmbeddingConfig } from "./semantic-commit-provider.js";

export interface CachedTaskCandidate { id: string; title: string; description?: string }
export interface CachedSessionCandidate { id: string; path: string; name?: string; firstMessage: string; snippet?: string }
export interface CachedProjectVectors {
  tasks: Map<string, number[]>;
  sessions: Map<string, number[]>;
  uncachedTasks: number;
  uncachedSessions: number;
}

interface QueryStatement { get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[] }
interface ReadonlyDatabase { prepare(sql: string): QueryStatement; exec(sql: string): unknown; close(): void }

async function regularFile(path: string, maxBytes: number): Promise<boolean> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= maxBytes);
}

/** Reuse ACP's project-owned index, but never create an index, tables, blobs,
 * or a new task/session entry in this read-only agent tool. */
async function openCachedIndex(root: string, source: "tasks" | "sessions"): Promise<ReadonlyDatabase | undefined> {
  for (const folder of [join(root, ".pi"), join(root, ".pi", "search")]) {
    const info = await lstat(folder).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search index directory");
  }
  const filename = join(root, ".pi", "search", `${source}.sqlite`);
  if (!await regularFile(filename, 512 * 1024 * 1024)) return;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await lstat(`${filename}${suffix}`).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    // nlink=0 is an already-unlinked SQLite sidecar, not a hard link.
    if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink > 1)) {
      throw new Error("Unsafe search index sidecar");
    }
  }
  if ("Bun" in globalThis) {
    const driver = "bun:sqlite";
    const { Database } = await import(driver);
    return new Database(filename, { readonly: true }) as unknown as ReadonlyDatabase;
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filename, { readOnly: true }) as unknown as ReadonlyDatabase;
}

function schemaCompatible(db: ReadonlyDatabase, namespace: "task" | "session", config: CommitEmbeddingConfig): boolean {
  const tables = namespace === "task"
    ? ["pix_task_index_meta", "pix_task_documents", "pix_task_vectors"]
    : ["pix_session_meta", "pix_session_titles", "pix_session_vectors"];
  const available = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (tables.some(name => !available.has(name))) return false;
  const get = db.prepare(`SELECT value FROM ${tables[0]} WHERE key=?`);
  return get.get("identity")?.value === commitIdentity(config)
    && get.get("model")?.value === config.model
    && get.get("dimensions")?.value === String(config.dimension)
    && get.get("encoding")?.value === "float32le";
}

function decodeVector(raw: unknown, dimension: number): number[] | undefined {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== dimension * 4) return;
  const data = Buffer.from(raw);
  const vector = Array.from({ length: dimension }, (_, index) => data.readFloatLE(index * 4));
  return validSearchVector(vector, dimension) ? vector : undefined;
}

/** Match ACP task-corpus.ts exactly; status, paths, attachments and model
 * assignment must never invalidate a paid title/description vector. */
export function taskSemanticText(task: CachedTaskCandidate): string {
  return `Task title: ${task.title.trim()}\nTask description: ${(task.description ?? "").trim()}`.slice(0, 2000);
}

export function taskSemanticHash(task: CachedTaskCandidate): string {
  return createHash("sha256").update(taskSemanticText(task)).digest("hex");
}

export interface NamedSessionLink { sessionId: string; name: string }

export async function sessionLinks(root: string, sessions: readonly CachedSessionCandidate[], options: SemanticSearchOptions,
  signal: AbortSignal): Promise<Map<string, NamedSessionLink>> {
  // Ordinary Pi/TUI saved names need no Desktop ACP map. Freshness below still
  // authenticates the name, project and native ID against the session file.
  const found = new Map<string, NamedSessionLink>();
  for (const session of sessions) {
    const name = session.name?.trim();
    if (name && name.length <= 2000 && name !== session.firstMessage.trim()) {
      found.set(session.id, { sessionId: session.id, name });
    }
  }
  const override = process.env.PIX_ACP_SESSION_MAP;
  const filename = options.sessionMapPath ?? (override !== undefined && isAbsolute(override) ? override : undefined)
    ?? join(homedir(), ".pi", "agent", "pix-acp", "sessions.json");
  if (!await regularFile(filename, 8 * 1024 * 1024)) return found;
  signal.throwIfAborted();
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1) return new Map();
  const records = (parsed as Record<string, unknown>).sessions;
  if (!Array.isArray(records) || records.length > 50_000) return new Map();
  const byPath = new Map(sessions.map(session => [resolve(session.path), session]));
  for (const record of records) {
    signal.throwIfAborted();
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const value = record as Record<string, unknown>;
    // Mapped Desktop sessions must satisfy the stronger two-authority contract;
    // an invalid/renamed map entry cannot fall back to a native-only name.
    if (typeof value.piSessionPath === "string") {
      const mapped = byPath.get(resolve(value.piSessionPath));
      if (mapped) found.delete(mapped.id);
    }
    if (typeof value.cwd !== "string" || resolve(value.cwd) !== root
      || typeof value.piSessionPath !== "string" || !isAbsolute(value.piSessionPath)
      || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256
      || typeof value.namedTitle !== "string" || !value.namedTitle.trim() || value.namedTitle.length > 2000
      || value.namedTitle !== value.title) continue;
    const current = byPath.get(resolve(value.piSessionPath));
    if (!current || !current.name || current.name.trim() !== value.namedTitle.trim()
      || current.name.trim() === current.firstMessage.trim()) continue;
    found.set(current.id, { sessionId: value.sessionId, name: value.namedTitle.trim() });
  }
  return found;
}

/** A query provider can be slower than another task edit. Never surface a
 * semantic pointer if its semantic text changed, its row was removed, or an
 * ACP session was renamed while the query embedding was in flight. */
export async function freshSemanticCandidates(root: string, inputs: {
  tasks: readonly CachedTaskCandidate[];
  sessions: readonly CachedSessionCandidate[];
}, options: SemanticSearchOptions, signal: AbortSignal): Promise<{ tasks: Set<string>; sessions: Set<string> }> {
  const fresh = { tasks: new Set<string>(), sessions: new Set<string>() };
  if (inputs.tasks.length) {
    const results = await withTaskDatabase(join(root, ".pi"), "read", db => {
      const ids = new Set<string>();
      if (!db) return ids;
      db.exec("BEGIN");
      try {
        const get = db.prepare("SELECT payload FROM tasks WHERE id=?");
        for (const captured of inputs.tasks) {
          signal.throwIfAborted();
          const row = get.get(captured.id);
          if (typeof row?.payload !== "string" || row.payload.length > 1024 * 1024) continue;
          const current: unknown = JSON.parse(row.payload);
          if (!current || typeof current !== "object" || Array.isArray(current)) continue;
          const task = current as Record<string, unknown>;
          if (task.id !== captured.id || typeof task.title !== "string"
            || (task.description !== undefined && typeof task.description !== "string")) continue;
          if (taskSemanticHash(task as unknown as CachedTaskCandidate) === taskSemanticHash(captured)) ids.add(captured.id);
        }
        db.exec("COMMIT");
        return ids;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    for (const id of results) fresh.tasks.add(id);
  }
  if (inputs.sessions.length) {
    const linked = await sessionLinks(root, inputs.sessions, options, signal).catch(() => {
      signal.throwIfAborted();
      return new Map<string, NamedSessionLink>();
    });
    for (const session of inputs.sessions) {
      signal.throwIfAborted();
      const record = linked.get(session.id);
      if (!record) continue;
      const info = await lstat(session.path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) continue;
      try {
        const manager = SessionManager.open(session.path);
        const header = manager.getHeader();
        if (header?.id === session.id && resolve(header.cwd) === root
          && manager.getSessionName()?.trim() === record.name) fresh.sessions.add(session.id);
      } catch { /* Missing/corrupt/renamed session does not become evidence. */ }
    }
  }
  return fresh;
}

/** Returned vectors are limited to *current authoritative* task payload hashes
 * and session records whose explicit names still match both the ACP map and
 * current native session listing. Stale rows never become search evidence. */
export async function readCachedProjectVectors(root: string, inputs: {
  tasks: readonly CachedTaskCandidate[]; sessions: readonly CachedSessionCandidate[];
}, options: SemanticSearchOptions, signal: AbortSignal, config: CommitEmbeddingConfig): Promise<CachedProjectVectors> {
  const isolated = async (source: "tasks" | "sessions") => {
    const scoped = { tasks: source === "tasks" ? inputs.tasks : [], sessions: source === "sessions" ? inputs.sessions : [] };
    try { return await readSourceVectors(root, scoped, options, signal, config); }
    catch {
      signal.throwIfAborted();
      return { tasks: new Map<string, number[]>(), sessions: new Map<string, number[]>(), uncachedTasks: scoped.tasks.length, uncachedSessions: scoped.sessions.length };
    }
  };
  const [tasks, sessions] = await Promise.all([isolated("tasks"), isolated("sessions")]);
  return { tasks: tasks.tasks, sessions: sessions.sessions, uncachedTasks: tasks.uncachedTasks, uncachedSessions: sessions.uncachedSessions };
}
async function readSourceVectors(root: string, inputs: {
  tasks: readonly CachedTaskCandidate[]; sessions: readonly CachedSessionCandidate[];
}, options: SemanticSearchOptions, signal: AbortSignal, config: CommitEmbeddingConfig): Promise<CachedProjectVectors> {
  const result: CachedProjectVectors = { tasks: new Map(), sessions: new Map(), uncachedTasks: 0, uncachedSessions: 0 };
  if (!inputs.tasks.length && !inputs.sessions.length) return result;
  const db = await openCachedIndex(root, inputs.tasks.length ? "tasks" : "sessions");
  if (!db) return { ...result, uncachedTasks: inputs.tasks.length, uncachedSessions: inputs.sessions.length };
  try {
    db.exec("PRAGMA busy_timeout=200; BEGIN");
    if (inputs.tasks.length && schemaCompatible(db, "task", config)) {
      const get = db.prepare("SELECT d.content_hash,v.vector FROM pix_task_documents d JOIN pix_task_vectors v ON v.content_hash=d.content_hash WHERE d.task_id=?");
      for (const task of inputs.tasks) {
        signal.throwIfAborted();
        const stored = get.get(task.id);
        if (!stored || stored.content_hash !== taskSemanticHash(task)) { result.uncachedTasks++; continue; }
        const vector = decodeVector(stored.vector, config.dimension);
        if (vector) result.tasks.set(task.id, vector);
        else result.uncachedTasks++;
      }
    } else result.uncachedTasks = inputs.tasks.length;
    if (inputs.sessions.length && schemaCompatible(db, "session", config)) {
      const named = await sessionLinks(root, inputs.sessions, options, signal).catch(() => {
        signal.throwIfAborted();
        return new Map<string, NamedSessionLink>();
      });
      const get = db.prepare("SELECT t.title,t.title_hash,v.vector FROM pix_session_titles t JOIN pix_session_vectors v ON v.title_hash=t.title_hash WHERE t.session_id=?");
      for (const session of inputs.sessions) {
        signal.throwIfAborted();
        const current = named.get(session.id);
        if (!current) continue;
        const row = get.get(current.sessionId);
        const titleHash = createHash("sha256").update(current.name).digest("hex");
        if (!row || row.title !== current.name || row.title_hash !== titleHash) { result.uncachedSessions++; continue; }
        const vector = decodeVector(row.vector, config.dimension);
        if (vector) result.sessions.set(session.id, vector);
        else result.uncachedSessions++;
      }
    } else result.uncachedSessions = inputs.sessions.length;
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Already unwound. */ }
    throw error;
  } finally { db.close(); }
}
