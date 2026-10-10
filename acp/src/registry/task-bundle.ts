import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import type { ProjectArtifact, RegistryRuntime } from "./model.js";
import { projectArtifactLocalPath, projectArtifactRegistryPath, projectTaskAttachmentsLocalPath, projectTaskAttachmentsRegistryPath } from "./paths.js";
import { hashPath } from "./resource-files.js";
import { assertTaskDirectory, assertTaskFile, importTaskRows, openTaskDatabase, readTaskRows, type TaskRows } from "./task-database.js";

export type TaskBundle = TaskRows & { attachmentsRoot: string };

export function pathIsWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function readBundle(path: string, attachmentsRoot: string): Promise<TaskBundle> {
	const db = await openTaskDatabase(path);
	try {
		db.exec("BEGIN");
		const bundle = { ...readTaskRows(db), attachmentsRoot };
		db.exec("COMMIT");
		return bundle;
	} finally { db.close(); }
}

export async function readLocalTaskBundle(cwd: string): Promise<TaskBundle> {
	return readBundle(projectArtifactLocalPath(cwd, "tasks"), projectTaskAttachmentsLocalPath(cwd));
}

export async function readRemoteTaskBundle(runtime: RegistryRuntime, projectKey: string): Promise<TaskBundle> {
	return readBundle(projectArtifactRegistryPath(runtime.cacheDir, projectKey, "tasks"), projectTaskAttachmentsRegistryPath(runtime.cacheDir, projectKey));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
	return value;
}

/** Read via O_NOFOLLOW and validate the opened inode, not just the pathname. */
async function blob(bundle: TaskBundle, row: TaskRows["attachments"][number]): Promise<Buffer> {
	await assertTaskDirectory(dirname(bundle.attachmentsRoot));
	await assertTaskDirectory(bundle.attachmentsRoot);
	const path = join(bundle.attachmentsRoot, row.hash);
	await assertTaskFile(path);
	const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.size) throw new Error(`Invalid task attachment size: ${row.hash}`);
		const bytes = await handle.readFile();
		if (createHash("sha256").update(bytes).digest("hex") !== row.hash) throw new Error(`Task attachment hash mismatch: ${row.hash}`);
		return bytes;
	} finally { await handle.close(); }
}

export async function hashTaskBundle(bundle: TaskBundle): Promise<string> {
	const hash = createHash("sha256");
	hash.update("tasks-sqlite-v1\0");
	hash.update(JSON.stringify(canonical({ tasks: bundle.tasks.map((row) => ({ ...row, payload: JSON.parse(row.payload) })), attachments: bundle.attachments, taskAttachments: bundle.taskAttachments })));
	for (const row of bundle.attachments) { hash.update(`\0${row.hash}\0`); hash.update(await blob(bundle, row)); }
	return hash.digest("hex");
}

export async function hashProjectArtifactLocal(cwd: string, artifact: ProjectArtifact): Promise<string> {
	return artifact === "tasks" ? hashTaskBundle(await readLocalTaskBundle(cwd)) : hashPath(projectArtifactLocalPath(cwd, artifact), artifact === "plans" ? "plans" : "resource");
}

export async function hashProjectArtifactRemote(runtime: RegistryRuntime, projectKey: string, artifact: ProjectArtifact): Promise<string> {
	return artifact === "tasks" ? hashTaskBundle(await readRemoteTaskBundle(runtime, projectKey)) : hashPath(projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact), artifact === "plans" ? "plans" : "resource");
}

/** Immutable content-addressed installs. Never remove local bytes on pull/rollback. */
async function copyBlobs(bundle: TaskBundle, destination: string): Promise<void> {
	if (!bundle.attachments.length) return;
	await assertTaskDirectory(dirname(destination));
	await fs.mkdir(destination, { recursive: true });
	await assertTaskDirectory(destination);
	for (const row of bundle.attachments) {
		const bytes = await blob(bundle, row);
		const target = join(destination, row.hash);
		const staged = join(destination, `.registry-${randomUUID()}.tmp`);
		try {
			await fs.writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
			// link is atomic and does not replace an existing file; drop the staging link
			// before validating single-link storage.
			try { await fs.link(staged, target); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		} finally { await fs.rm(staged, { force: true }); }
		await blob({ ...bundle, attachmentsRoot: destination }, row);
	}
}

/** SQLite online backup captures committed WAL state; never copy a live DB file. */
export async function replaceRemoteTaskBundle(cwd: string, runtime: RegistryRuntime, projectKey: string, expectedHash?: string): Promise<void> {
	const target = projectArtifactRegistryPath(runtime.cacheDir, projectKey, "tasks");
	await fs.mkdir(dirname(target), { recursive: true });
	await assertTaskDirectory(dirname(dirname(target)));
	await assertTaskDirectory(dirname(target));
	await assertTaskFile(target, true);
	for (const suffix of ["-wal", "-shm", "-journal"]) {
		if (await assertTaskFile(`${target}${suffix}`, true, true)) throw new Error("Registry task snapshot has live SQLite sidecars");
	}
	const staged = join(dirname(target), `.tasks-${randomUUID()}.sqlite`);
	const source = await openTaskDatabase(projectArtifactLocalPath(cwd, "tasks"));
	let snapshot: DatabaseSync | undefined;
	try {
		await backup(source, staged);
		snapshot = await openTaskDatabase(staged, true);
		snapshot.exec("BEGIN IMMEDIATE; DELETE FROM attachments WHERE hash NOT IN (SELECT hash FROM task_attachments); COMMIT;");
		const bundle = { ...readTaskRows(snapshot), attachmentsRoot: projectTaskAttachmentsLocalPath(cwd) };
		const actual = await hashTaskBundle(bundle);
		if (expectedHash !== undefined && actual !== expectedHash) throw new Error("Project tasks changed during registry push; retry");
		const attachmentsRoot = projectTaskAttachmentsRegistryPath(runtime.cacheDir, projectKey);
		await copyBlobs(bundle, attachmentsRoot);
		snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		snapshot.close(); snapshot = undefined;
		await fs.rename(staged, target);
		// The remote checkout is serialized by the registry cache lock.
		try {
			await assertTaskDirectory(attachmentsRoot);
			const referenced = new Set(bundle.attachments.map((row) => row.hash));
			for (const name of await fs.readdir(attachmentsRoot)) if (!referenced.has(name)) {
				await assertTaskFile(join(attachmentsRoot, name));
				await fs.unlink(join(attachmentsRoot, name));
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	} finally {
		snapshot?.close(); source.close();
		for (const suffix of ["", "-wal", "-shm", "-journal"]) await fs.rm(`${staged}${suffix}`, { force: true });
	}
}

/** Replace rows under the writer lock, retaining the DB inode and all local blobs. */
export async function replaceLocalTaskBundle(cwd: string, runtime: RegistryRuntime, projectKey: string, expectedLocalHash?: string, expectedRemoteHash?: string): Promise<void> {
	const bundle = await readRemoteTaskBundle(runtime, projectKey);
	if (expectedRemoteHash !== undefined && await hashTaskBundle(bundle) !== expectedRemoteHash) throw new Error("Registry tasks changed during pull; retry");
	const target = projectArtifactLocalPath(cwd, "tasks");
	await fs.mkdir(dirname(target), { recursive: true });
	await assertTaskDirectory(dirname(target));
	await copyBlobs(bundle, projectTaskAttachmentsLocalPath(cwd));
	const db = await openTaskDatabase(target, true);
	try {
		db.exec("BEGIN IMMEDIATE");
		if (expectedLocalHash !== undefined && await hashTaskBundle({ ...readTaskRows(db), attachmentsRoot: projectTaskAttachmentsLocalPath(cwd) }) !== expectedLocalHash) throw new Error("Project tasks changed during registry pull; retry");
		importTaskRows(db, bundle);
		db.exec("COMMIT");
	} catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
	finally { db.close(); }
}
