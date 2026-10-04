import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createDesktopForkSnapshot } from "../src/acp/desktop-fork-snapshot.js";

async function fixture() {
	const root = fileURLToPath(new URL("../../.pi/artifacts/desktop-fork-backend-20260723/", import.meta.url));
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "snapshot-"));
	const path = join(dir, "source.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "source", timestamp, cwd: dir },
		{ type: "model_change", id: "model", parentId: null, timestamp, provider: "anthropic", modelId: "claude" },
		{ type: "message", id: "user", parentId: "model", timestamp, message: { role: "user", content: "do work", timestamp: 1 } },
		{ type: "message", id: "assistant", parentId: "user", timestamp, message: {
			role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }],
			api: "anthropic-messages", provider: "anthropic", model: "claude", stopReason: "toolUse", timestamp: 2,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} },
		{ type: "message", id: "tool", parentId: "assistant", timestamp, message: {
			role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3,
		} },
		{ type: "message", id: "later-user", parentId: "tool", timestamp, message: { role: "user", content: "later", timestamp: 4 } },
	];
	await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { dir, path };
}

test("native SDK worker branches THROUGH the captured tool result, independent of the advanced source", async () => {
	const { dir, path } = await fixture();
	const before = await readFile(path, "utf8");
	const child = await createDesktopForkSnapshot({ sessionPath: path, leafId: "tool", cwd: dir });
	assert.notEqual(child.sessionPath, path); assert.notEqual(child.piSessionId, "source");
	const manager = SessionManager.open(child.sessionPath);
	assert.deepEqual(manager.getEntries().map((entry) => entry.id), ["model", "user", "assistant", "tool"]);
	assert.equal(manager.getLeafId(), "tool");
	assert.equal(manager.getHeader()?.parentSession, path);
	assert.equal(await readFile(path, "utf8"), before, "source disk contents are never mutated");
	await rm(dir, { recursive: true });
});

test("native SDK worker produces a loadable independent empty child for a fresh idle source", async () => {
	const { dir, path } = await fixture();
	const child = await createDesktopForkSnapshot({ sessionPath: path, leafId: null, cwd: dir });
	const manager = SessionManager.open(child.sessionPath);
	assert.deepEqual(manager.getEntries(), []);
	assert.equal(manager.getHeader()?.parentSession, path);
	await rm(dir, { recursive: true });
});

test("native SDK worker rejects a missing captured leaf instead of cloning a newer branch", async () => {
	const { dir, path } = await fixture();
	await assert.rejects(createDesktopForkSnapshot({ sessionPath: path, leafId: "missing", cwd: dir }), /not found/u);
	await rm(dir, { recursive: true });
});

test("native SDK worker preserves unflushed model and thinking entries from a fresh idle session", async () => {
	const { dir } = await fixture();
	const source = SessionManager.create(dir, dir);
	source.appendModelChange("anthropic", "claude");
	source.appendThinkingLevelChange("high");
	const path = source.getSessionFile()!;
	await assert.rejects(readFile(path), { code: "ENOENT" });
	const child = await createDesktopForkSnapshot({ sessionPath: path, leafId: source.getLeafId(), cwd: dir,
		unflushedEntries: source.getEntries() as unknown as Record<string, unknown>[] });
	const manager = SessionManager.open(child.sessionPath);
	assert.deepEqual(manager.getEntries(), source.getEntries());
	assert.equal(manager.getHeader()?.parentSession, path);
	assert.notEqual(manager.getSessionId(), source.getSessionId());
	await assert.rejects(readFile(path), { code: "ENOENT" }, "source is not flushed or mutated");
	await rm(dir, { recursive: true });
});

test("native SDK worker preserves metadata-only branches even when SDK defers flushing", async () => {
	const { dir, path } = await fixture();
	const child = await createDesktopForkSnapshot({ sessionPath: path, leafId: "model", cwd: dir });
	const manager = SessionManager.open(child.sessionPath);
	assert.deepEqual(manager.getEntries().map((entry) => entry.id), ["model"]);
	assert.equal(manager.getLeafId(), "model");
	await rm(dir, { recursive: true });
});
