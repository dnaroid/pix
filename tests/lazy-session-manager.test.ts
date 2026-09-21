import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		Array.from({ length: 12 }, (_value, index) => `entry-${index}`),
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

test("lazy session manager never treats a crash-tail user message as a new provider-context root", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-crash-tail-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "session-crash", timestamp: "2026-09-12T09:22:07.581Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "m001-entry", parentId: null, timestamp: "2026-09-12T09:22:08.000Z", message: { role: "user", content: "original objective", timestamp: 1 } }),
	];
	let parentId = "m001-entry";
	for (let index = 2; index <= 225; index += 1) {
		const id = `entry-${String(index).padStart(3, "0")}`;
		lines.push(JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: `2026-09-12T09:30:${String(index % 60).padStart(2, "0")}.000Z`,
			message: { role: "assistant", content: `work ${index}`, timestamp: index },
		}));
		parentId = id;
	}
	lines.push(
		JSON.stringify({ type: "message", id: "m226-entry", parentId, timestamp: "2026-09-12T10:01:23.228Z", message: { role: "user", content: "continue and compress", timestamp: 226 } }),
		JSON.stringify({ type: "message", id: "m227-entry", parentId: "m226-entry", timestamp: "2026-09-12T10:01:23.305Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", timestamp: 227 } }),
		JSON.stringify({ type: "thinking_level_change", id: "thinking-tail", parentId: "m227-entry", timestamp: "2026-09-12T10:02:37.863Z", thinkingLevel: "medium" }),
	);
	await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 4 });
	assert.deepEqual(manager.getBranch().map((entry) => entry.id), ["entry-225", "m226-entry", "m227-entry", "thinking-tail"]);

	manager.appendMessage({ role: "user", content: "continue after restart", timestamp: 228 } as never);
	const context = manager.buildSessionContext().messages;

	assert.equal(context.length, 228);
	assert.equal(context[0]?.role, "user");
	assert.equal((context[0] as { content?: unknown } | undefined)?.content, "original objective");
	assert.equal(context.at(-3)?.role, "user");
	assert.equal(context.at(-2)?.role, "assistant");
	assert.equal(context.at(-1)?.role, "user");
	assert.equal((context.at(-1) as { content?: unknown } | undefined)?.content, "continue after restart");
	assert.ok((manager as unknown as { createHistoryReader(): LazySessionHistoryReader | undefined }).createHistoryReader()?.hasOlder());
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

test("lazy session manager preserves summary usage added by SDK 0.81", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-usage-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first" } }),
		JSON.stringify({ type: "message", id: "user-2", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "tail" } }),
		"",
	].join("\n"), "utf8");

	const usage = {
		input: 4,
		output: 2,
		cacheRead: 1,
		cacheWrite: 0,
		totalTokens: 7,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
	};
	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	manager.appendCompaction("compact", "user-2", 10, undefined, false, usage);

	const fullEntries = await (manager as unknown as { readFullSessionEntries(): Promise<Array<{ type: string; usage?: unknown }>> }).readFullSessionEntries();
	assert.deepEqual(fullEntries.find((entry) => entry.type === "compaction")?.usage, usage);

	const branchSummaryId = manager.branchWithSummary("user-1", "branch", undefined, false, usage);
	const branchSummary = manager.getEntry(branchSummaryId);
	assert.deepEqual(branchSummary?.type === "branch_summary" ? branchSummary.usage : undefined, usage);
});

test("lazy session manager appends model-attributed usage with the SDK return shape", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-append-usage-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "session", version: 3, id: "session-usage", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first", timestamp: 1 } }),
		"",
	].join("\n"), "utf8");

	const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	const entry = manager.appendUsage("cache_warm", "test-provider", "test-model", usage, "warm cache");

	assert.equal(entry.type, "usage");
	assert.equal(entry.parentId, "user-1");
	assert.equal(entry.kind, "cache_warm");
	assert.equal(entry.note, "warm cache");
	assert.deepEqual(entry.usage, usage);
	assert.equal(manager.getLeafId(), entry.id);
	assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["user"]);
});

test("lazy session manager projects full context edits without hydrating its presentation tail", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-context-edit-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "session", version: 3, id: "session-edits", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "system", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "system", content: "base instructions", timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "user-old", parentId: "system", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "replace me", timestamp: 2 } }),
		JSON.stringify({ type: "message", id: "side-user", parentId: "user-old", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "side branch", timestamp: 3 } }),
		JSON.stringify({ type: "message", id: "active-user", parentId: "user-old", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "active branch", timestamp: 4 } }),
		"",
	].join("\n"), "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	assert.deepEqual(manager.getBranch().map((entry) => entry.id), ["active-user"]);

	const editId = manager.appendContextEdit("user-old", { content: "edited ancestor" });
	const projection = manager.buildSessionProjection();
	assert.deepEqual(projection.messages.map((message) => message.role), ["system", "user", "user"]);
	assert.deepEqual(projection.messages.map((message) => "content" in message ? message.content : undefined), ["base instructions", "edited ancestor", "active branch"]);
	assert.equal(projection.entries.find((entry) => entry.sourceEntry.id === editId)?.messages.length, 0);
	assert.deepEqual(manager.getBranch().map((entry) => entry.id), ["active-user", editId]);

	assert.throws(() => manager.appendContextEdit("side-user", { content: "must reject inactive branch" }), /not on the active branch/);
	assert.throws(() => manager.appendContextEdit("user-old", {} as never), /must be null or contain string\/array content/);
});

test("lazy session manager snapshots the canonical system state when compacting", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-compaction-system-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "session", version: 3, id: "session-compaction", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "system", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "system", content: "base instructions", timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "user", parentId: "system", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "compact this", timestamp: 2 } }),
		"",
	].join("\n"), "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	const compactionId = manager.appendCompaction("summary", null, 10);
	const compaction = manager.getEntry(compactionId);
	if (!compaction || compaction.type !== "compaction") throw new Error("Expected compaction entry");

	assert.equal(compaction.firstKeptEntryId, compactionId);
	assert.equal(compaction.systemMessage?.role, "system");
	assert.equal(compaction.systemMessage?.content, "base instructions");
	assert.equal(typeof compaction.systemMessage?.timestamp, "number");
	assert.deepEqual(manager.buildSessionProjection().messages.map((message) => message.role), ["system", "compactionSummary"]);
	assert.deepEqual(manager.getBranch().map((entry) => entry.id), ["user", compactionId]);
});

test("lazy session manager does not publish a phantom in-memory entry when append persistence fails", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-lazy-session-append-fail-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first" } }),
		"",
	].join("\n"), "utf8");

	const manager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 10 });
	const beforeIds = manager.getBranch().map((entry) => entry.id);
	await rm(sessionPath);
	await mkdir(sessionPath);

	assert.throws(() => manager.appendCustomEntry("dcp-journal", { operationId: "should-not-stick" }));
	assert.deepEqual(manager.getBranch().map((entry) => entry.id), beforeIds);
	assert.equal(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "dcp-journal"), false);
});
