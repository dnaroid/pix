import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadResumeSessionsInChunks } from "../src/app/session/resume-session-loader.js";

describe("resume session loader", () => {
	it("publishes the first sessions before loading remaining chunks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-resume-loader-"));
		try {
			const cwd = join(root, "workspace");
			const sessionDir = join(root, "sessions");
			await mkdir(cwd);
			await mkdir(sessionDir);

			for (let index = 0; index < 5; index++) {
				await writeSession({
					cwd,
					sessionDir,
					id: `session-${index}`,
					created: `2026-01-01T00:0${index}:00.000Z`,
					modified: `2026-01-01T00:0${index}:30.000Z`,
					message: `message ${index}`,
				});
			}

			const chunks: { ids: string[]; loaded: number; total: number; done: boolean }[] = [];
			const sessions = await loadResumeSessionsInChunks({
				cwd,
				sessionDir,
				initialChunkSize: 2,
				chunkSize: 2,
				onChunk: (chunkSessions, progress) => {
					chunks.push({
						ids: chunkSessions.map((session) => session.id),
						loaded: progress.loaded,
						total: progress.total,
						done: progress.done,
					});
				},
			});

			assert.deepEqual(chunks.map((chunk) => chunk.loaded), [2, 4, 5]);
			assert.deepEqual(chunks.map((chunk) => chunk.total), [5, 5, 5]);
			assert.deepEqual(chunks.map((chunk) => chunk.done), [false, false, true]);
			assert.deepEqual(chunks[0]?.ids, ["session-4", "session-3"]);
			assert.deepEqual(sessions.map((session) => session.id), ["session-4", "session-3", "session-2", "session-1", "session-0"]);
			assert.equal(sessions[0]?.firstMessage, "message 4");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports an empty completed chunk when no sessions exist", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-resume-loader-empty-"));
		try {
			const cwd = join(root, "workspace");
			const sessionDir = join(root, "sessions");
			await mkdir(cwd);
			await mkdir(sessionDir);

			const chunks: unknown[] = [];
			const sessions = await loadResumeSessionsInChunks({
				cwd,
				sessionDir,
				onChunk: (chunkSessions, progress) => chunks.push({ count: chunkSessions.length, progress }),
			});

			assert.deepEqual(sessions, []);
			assert.deepEqual(chunks, [{ count: 0, progress: { loaded: 0, total: 0, done: true } }]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function writeSession(options: {
	cwd: string;
	sessionDir: string;
	id: string;
	created: string;
	modified: string;
	message: string;
}): Promise<void> {
	const path = join(options.sessionDir, `${options.created.replace(/[:.]/g, "-")}_${options.id}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: options.id, timestamp: options.created, cwd: options.cwd },
		{
			type: "message",
			id: `${options.id}-user`,
			parentId: null,
			timestamp: options.modified,
			message: { role: "user", content: options.message, timestamp: new Date(options.modified).getTime() },
		},
	];
	await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	const modified = new Date(options.modified);
	await utimes(path, modified, modified);
}
