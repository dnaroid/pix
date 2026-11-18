import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openTaskDatabase } from "../registry/task-database.js";

/**
 * Supervisor `close` (and `reopen`) sets the status of the saved task behind a managed
 * session (decision 0077). Same storage contract as the other writers:
 * an immediate transaction and an optimistic revision check on one row.
 * Returns false when the project has no task store or no such task.
 */
export async function writeTaskStatus(cwd: string, taskId: string, status: "done" | "failed" | "in-progress"): Promise<boolean> {
	const path = join(cwd, ".pi", "tasks.sqlite");
	try {
		await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const db = await openTaskDatabase(path, true);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = db.prepare("SELECT payload, revision FROM tasks WHERE id=?").get(taskId) as { payload: string; revision: number } | undefined;
			if (!row) {
				db.exec("ROLLBACK");
				return false;
			}
			const payload: unknown = JSON.parse(row.payload);
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Invalid task payload: ${taskId}`);
			if ((payload as Record<string, unknown>)["status"] === status) {
				db.exec("ROLLBACK");
				return true;
			}
			const next = { ...payload, status, updatedAt: new Date().toISOString() };
			const result = db.prepare("UPDATE tasks SET payload=?, revision=revision+1 WHERE id=? AND revision=?")
				.run(JSON.stringify(next), taskId, row.revision);
			if (Number(result.changes) !== 1) throw new Error(`Task ${taskId} changed concurrently; retry`);
			db.exec("COMMIT");
			return true;
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
			throw error;
		}
	} finally {
		db.close();
	}
}
