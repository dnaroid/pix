import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openLazySessionManager, type LazySessionHistoryReader } from "../src/app/session/lazy-session-manager.js";

test("lazy session manager exposes the tail branch and reads older entries on demand", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
	];
	let parentId: string | null = null;
	for (let index = 0; index < 12; index += 1) {
		const id = `entry-${index}`;
		lines.push(JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
			message: { role: "user", content: `message ${index}` },
		}));
		parentId = id;
	}
	await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 5 });

	assert.deepEqual(
		manager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id),
		Array.from({ length: 5 }, (_value, index) => `entry-${index + 7}`),
	);
	assert.deepEqual(
		manager.buildContextEntries().filter((entry) => entry.type === "message").map((entry) => entry.id),
		Array.from({ length: 5 }, (_value, index) => `entry-${index + 7}`),
	);

	const reader = (manager as unknown as { createHistoryReader(): LazySessionHistoryReader | undefined }).createHistoryReader();
	if (!reader) throw new Error("Expected lazy history reader");
	assert.ok(reader.hasOlder());
	assert.deepEqual((await reader.readOlder(4)).map((entry) => entry.id), ["entry-3", "entry-4", "entry-5", "entry-6"]);
	assert.deepEqual((await reader.readOlder(4)).map((entry) => entry.id), ["entry-0", "entry-1", "entry-2"]);
	assert.equal(reader.hasOlder(), false);

	const fullBranch = await (manager as unknown as { readFullBranchEntries(): Promise<Array<{ id: string }>> }).readFullBranchEntries();
	assert.deepEqual(fullBranch.map((entry) => entry.id), Array.from({ length: 12 }, (_value, index) => `entry-${index}`));
	const fullSession = await (manager as unknown as { readFullSessionEntries(): Promise<Array<{ id: string }>> }).readFullSessionEntries();
	assert.deepEqual(fullSession.map((entry) => entry.id), Array.from({ length: 12 }, (_value, index) => `entry-${index}`));
});

test("lazy session manager reads past oversized history entries", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-large-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const oversizedContent = "x".repeat(17 * 1024 * 1024);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "entry-0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first" } }),
		JSON.stringify({ type: "message", id: "entry-large", parentId: "entry-0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: oversizedContent } }),
		JSON.stringify({ type: "message", id: "entry-tail", parentId: "entry-large", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "tail" } }),
	];
	await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	const reader = (manager as unknown as { createHistoryReader(): LazySessionHistoryReader | undefined }).createHistoryReader();
	if (!reader) throw new Error("Expected lazy history reader");

	assert.deepEqual((await reader.readOlder(2)).map((entry) => entry.id), ["entry-0", "entry-large"]);
	assert.equal(reader.hasOlder(), false);
});

test("lazy session manager does not expose older history when the full file is already loaded", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-full-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
	];
	let parentId: string | null = null;
	for (let index = 0; index < 3; index += 1) {
		const id = `entry-${index}`;
		lines.push(JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
			message: { role: "user", content: `message ${index}` },
		}));
		parentId = id;
	}
	await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 10 });

	assert.equal((manager as unknown as { createHistoryReader(): LazySessionHistoryReader | undefined }).createHistoryReader(), undefined);
});
