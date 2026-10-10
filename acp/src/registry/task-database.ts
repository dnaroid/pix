import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectArtifactLocalPath } from "./paths.js";

export const TASK_SCHEMA = `
CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL);
CREATE TABLE task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES attachments(hash), ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,hash));
PRAGMA user_version=1;`;

export type TaskRow = { id: string; payload: string; revision: number; position: number };
export type AttachmentRow = { hash: string; name: string; size: number };
export type TaskAttachmentRow = { task_id: string; hash: string; ordinal: number };
export type TaskRows = { tasks: TaskRow[]; attachments: AttachmentRow[]; taskAttachments: TaskAttachmentRow[] };

export async function assertTaskDirectory(path: string): Promise<void> {
	const stat = await fs.lstat(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Task storage must be a regular directory: ${path}`);
}

/** Sidecar metadata can be captured after SQLite unlinked the inode (nlink=0)
 * in a concurrent last-close race on APFS. It is already gone, not hard-linked.
 * Only the ephemeral SQLite sidecars may accept this state; the main DB and
 * immutable blobs continue to require exactly one hard link. */
export function safeTaskFileNlink(nlink: number, allowUnlinked = false): boolean {
	return nlink === 1 || (allowUnlinked && nlink === 0);
}

export async function assertTaskFile(path: string, optional = false, allowUnlinked = false): Promise<boolean> {
	try {
		const stat = await fs.lstat(path);
		if (stat.isSymbolicLink() || !stat.isFile() || !safeTaskFileNlink(stat.nlink, allowUnlinked)) throw new Error(`Task storage must be a regular single-link file: ${path}`);
		return stat.nlink !== 0;
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Also reject dangling symlinks, including SQLite's sidecars. */
export async function openTaskDatabase(path: string, create = false): Promise<DatabaseSync> {
	await assertTaskDirectory(dirname(dirname(path)));
	await assertTaskDirectory(dirname(path));
	const exists = await assertTaskFile(path, create);
	for (const suffix of ["-wal", "-shm", "-journal"]) await assertTaskFile(`${path}${suffix}`, true, true);
	const db = new DatabaseSync(path, { readOnly: !create });
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
		if (create) db.exec("PRAGMA journal_mode=WAL;");
		if (!exists) db.exec(TASK_SCHEMA);
		validateTaskDatabase(db);
		return db;
	} catch (error) { db.close(); throw error; }
}

export function validateTaskDatabase(db: DatabaseSync): void {
	if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) throw new Error("Unsupported task SQLite schema version (expected 1)");
	for (const [table, columns] of Object.entries({ tasks: ["id", "payload", "revision", "position"], attachments: ["hash", "name", "size"], task_attachments: ["task_id", "hash", "ordinal"] })) {
		const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
		if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error(`Invalid task SQLite schema: ${table}`);
	}
	if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid task SQLite attachment references");
}

/** Only referenced attachment metadata is part of the portable bundle. */
export function readTaskRows(db: DatabaseSync): TaskRows {
	validateTaskDatabase(db);
	const tasks = db.prepare("SELECT id,payload,revision,position FROM tasks ORDER BY id").all() as TaskRow[];
	const attachments = db.prepare("SELECT hash,name,size FROM attachments WHERE hash IN (SELECT hash FROM task_attachments) ORDER BY hash").all() as AttachmentRow[];
	const taskAttachments = db.prepare("SELECT task_id,hash,ordinal FROM task_attachments ORDER BY task_id,hash").all() as TaskAttachmentRow[];
	for (const row of tasks) {
		if (typeof row.id !== "string" || !row.id || typeof row.payload !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.position)) throw new Error("Invalid task SQLite row");
		const payload: unknown = JSON.parse(row.payload);
		if (!payload || typeof payload !== "object" || Array.isArray(payload) || (payload as { id?: unknown }).id !== row.id) throw new Error("Invalid task SQLite payload/id");
	}
	for (const row of attachments) {
		if (!/^[a-f0-9]{64}$/.test(row.hash) || typeof row.name !== "string" || !Number.isSafeInteger(row.size) || row.size < 0) throw new Error("Invalid task SQLite attachment metadata");
	}
	for (const row of taskAttachments) if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0) throw new Error("Invalid task SQLite attachment ordinal");
	return { tasks, attachments, taskAttachments };
}

export function importTaskRows(db: DatabaseSync, rows: TaskRows): void {
	db.exec("DELETE FROM task_attachments; DELETE FROM tasks; DELETE FROM attachments;");
	const task = db.prepare("INSERT INTO tasks(id,payload,revision,position) VALUES(?,?,?,?)");
	for (const row of rows.tasks) task.run(row.id, row.payload, row.revision, row.position);
	const attachment = db.prepare("INSERT INTO attachments(hash,name,size) VALUES(?,?,?)");
	for (const row of rows.attachments) attachment.run(row.hash, row.name, row.size);
	const reference = db.prepare("INSERT INTO task_attachments(task_id,hash,ordinal) VALUES(?,?,?)");
	for (const row of rows.taskAttachments) reference.run(row.task_id, row.hash, row.ordinal);
}

export async function localTasksExist(cwd: string): Promise<boolean> {
	try { await fs.lstat(projectArtifactLocalPath(cwd, "tasks")); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return false;
	}
}
