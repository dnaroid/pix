import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadDesktopQueues, removeDesktopQueueTab, saveDesktopQueues } from "../src/acp/queue-store.js";
import { tuiTabSnapshotPath } from "../src/acp/tui-tabs.js";

test("fork queue round-trips attachments/errors independently and old writers preserve it", async () => {
	const root = fileURLToPath(new URL("../../.pi/artifacts/desktop-fork-backend-20260723/", import.meta.url));
	await mkdir(root, { recursive: true });
	const agentDir = await mkdtemp(join(root, "queue-store-"));
	const cwd = "/tmp/fork-project";
	const path = resolve("/tmp/fork-session.jsonl");
	const message = { id: "fork", promptText: "expanded", displayText: "@file", error: "disk full", images: [
		{ type: "image" as const, data: "abc", mimeType: "image/png" },
	] };
	await saveDesktopQueues(cwd, path, { auto: [], deferred: [], fork: [message] }, agentDir);
	await saveDesktopQueues(cwd, path, { auto: [], deferred: [] }, agentDir);
	assert.deepEqual((await loadDesktopQueues(cwd, path, agentDir)).fork, [message]);
	await saveDesktopQueues(cwd, path, { auto: [], deferred: [], fork: [] }, agentDir);
	assert.deepEqual((await loadDesktopQueues(cwd, path, agentDir)).fork, []);
	await removeDesktopQueueTab(cwd, path, agentDir);
	assert.deepEqual(JSON.parse(await readFile(tuiTabSnapshotPath(cwd, agentDir), "utf8")).tabs, []);
});

test("Desktop queue persistence reuses the TUI v4 tab snapshot without clobbering tab UI state", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pix-queue-store-"));
	const cwd = "/tmp/project/../project";
	const sessionPath = resolve("/tmp/pi-sessions/queue-store.jsonl");
	const snapshotPath = tuiTabSnapshotPath(cwd, agentDir);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(join(agentDir, "pix", "tabs"), { recursive: true }));
	await writeFile(snapshotPath, JSON.stringify({
		version: 4,
		cwd: resolve(cwd),
		activePath: sessionPath,
		tabs: [{
			path: sessionPath,
			title: "Keep me",
			input: { text: "draft", cursor: 5 },
			scrollState: { scrollFromBottom: 12 },
			deferredUserMessages: [{
				id: "old",
				promptText: "old paused",
				displayText: "old paused",
				images: [],
			}],
		}],
	}, null, 2), "utf8");

	const loaded = await loadDesktopQueues(cwd, sessionPath, agentDir);
	assert.equal(loaded.deferred[0]?.displayText, "old paused");

	await saveDesktopQueues(cwd, sessionPath, {
		auto: [{
			id: "auto-1",
			promptText: "next turn",
			displayText: "next turn",
			images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		}],
		deferred: [{
			id: "pause-1",
			promptText: "later",
			displayText: "later",
			images: [],
		}],
	}, agentDir);

	const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as {
		version: number;
		activePath: string;
		tabs: Array<Record<string, unknown>>;
	};
	assert.equal(parsed.version, 4);
	assert.equal(parsed.activePath, sessionPath);
	assert.equal(parsed.tabs[0]?.title, "Keep me");
	assert.deepEqual(parsed.tabs[0]?.input, { text: "draft", cursor: 5 });
	assert.deepEqual(parsed.tabs[0]?.scrollState, { scrollFromBottom: 12 });
	assert.equal((parsed.tabs[0]?.autoUserMessages as unknown[])?.length, 1);
	assert.equal((parsed.tabs[0]?.deferredUserMessages as unknown[])?.length, 1);

	await saveDesktopQueues(cwd, sessionPath, { auto: [], deferred: [] }, agentDir);
	const cleared = JSON.parse(await readFile(snapshotPath, "utf8")) as { tabs: Array<Record<string, unknown>> };
	assert.equal("autoUserMessages" in cleared.tabs[0]!, false);
	assert.equal("deferredUserMessages" in cleared.tabs[0]!, false);
	assert.equal(cleared.tabs[0]?.title, "Keep me");
});

test("Desktop queue persistence never overwrites a future or malformed TUI tab snapshot", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pix-queue-store-future-"));
	const cwd = "/tmp/future-project";
	const sessionPath = resolve("/tmp/pi-sessions/future.jsonl");
	const snapshotPath = tuiTabSnapshotPath(cwd, agentDir);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(join(agentDir, "pix", "tabs"), { recursive: true }));

	const future = JSON.stringify({ version: 99, futureField: "keep", tabs: [{ path: sessionPath }] });
	await writeFile(snapshotPath, future, "utf8");
	await assert.rejects(
		saveDesktopQueues(cwd, sessionPath, { auto: [], deferred: [] }, agentDir),
		/refusing to overwrite/,
	);
	assert.equal(await readFile(snapshotPath, "utf8"), future);

	await writeFile(snapshotPath, "not-json", "utf8");
	await assert.rejects(
		saveDesktopQueues(cwd, sessionPath, { auto: [], deferred: [] }, agentDir),
		/refusing to overwrite/,
	);
	assert.equal(await readFile(snapshotPath, "utf8"), "not-json");
});
