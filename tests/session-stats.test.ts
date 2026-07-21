import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";

import { openLazySessionManager } from "../src/app/session/lazy-session-manager.js";
import { getCompleteSessionStats } from "../src/app/session/session-stats.js";

test("complete session stats aggregate the full lazy history without hydrating startup", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-session-stats-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const entries = [
		{ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
		{ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cost: { total: 0.25 } },
			},
		},
		{ type: "message", id: "tool-1", parentId: "assistant-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
		{ type: "compaction", id: "compaction-1", parentId: "tool-1", timestamp: "2026-01-01T00:00:04.000Z", summary: "summary", firstKeptEntryId: "tool-1", tokensBefore: 20, usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.03 } } },
		{ type: "branch_summary", id: "branch-1", parentId: "compaction-1", timestamp: "2026-01-01T00:00:05.000Z", fromId: "tool-1", summary: "branch", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 1, cost: { total: 0.04 } } },
		{ type: "message", id: "user-2", parentId: "branch-1", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "user", content: "thanks" } },
	];
	await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

	const sessionManager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	const base: SessionStats = {
		sessionFile: sessionPath,
		sessionId: "session-1",
		userMessages: 1,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 1,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		contextUsage: { tokens: 19, contextWindow: 1000, percent: 1.9 },
	};
	const session = {
		sessionManager,
		getSessionStats: () => base,
	} as unknown as AgentSession;

	const stats = await getCompleteSessionStats(session);
	assert.deepEqual(stats, {
		...base,
		userMessages: 2,
		assistantMessages: 1,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: 4,
		tokens: { input: 19, output: 9, cacheRead: 4, cacheWrite: 3, total: 35 },
		cost: 0.34,
	});

	assert.ok((sessionManager as unknown as { createHistoryReader(): unknown }).createHistoryReader());
});

test("legacy sessions are migrated before full-history stats are aggregated", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-session-stats-v1-"));
	t.after(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	const sessionPath = join(dir, "session.jsonl");
	const entries = [
		{ type: "session", id: "session-v1", timestamp: "2025-01-01T00:00:00.000Z", cwd: dir },
		{ type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
		{
			type: "message",
			timestamp: "2025-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.1 } },
			},
		},
	];
	await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

	const sessionManager = await openLazySessionManager(sessionPath, { cwdOverride: dir, tailEntryCount: 1 });
	const base: SessionStats = {
		sessionFile: sessionPath,
		sessionId: "session-v1",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};
	const stats = await getCompleteSessionStats({ sessionManager, getSessionStats: () => base } as unknown as AgentSession);

	assert.equal(sessionManager.getEntries().length, 2);
	assert.deepEqual(stats.tokens, { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, total: 10 });
	assert.equal(stats.userMessages, 1);
	assert.equal(stats.assistantMessages, 1);
});
