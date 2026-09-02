import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionMapStore, type SessionMapRecord } from "../src/acp/session-map.js";
import type { Logger } from "../src/logging.js";

const LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function tempMapPath(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "pix-acp-map-")), "sessions.json");
}

function record(sessionId: string, overrides: Partial<SessionMapRecord> = {}): SessionMapRecord {
	return {
		sessionId,
		piSessionPath: `/tmp/pi-sessions/${sessionId}.jsonl`,
		piSessionId: `pi-${sessionId}`,
		cwd: "/tmp/project",
		updatedAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

test("put/get/delete round-trips through disk", async () => {
	const path = await tempMapPath();
	const store = new SessionMapStore(path, LOGGER);
	await store.put(record("a"));
	await store.put(record("b", { cwd: "/tmp/other" }));

	const reloaded = new SessionMapStore(path, LOGGER);
	assert.equal((await reloaded.get("a"))?.piSessionPath, "/tmp/pi-sessions/a.jsonl");
	assert.deepEqual((await reloaded.list()).map((r) => r.sessionId), ["a", "b"]);

	await reloaded.delete("a");
	assert.equal(await reloaded.get("a"), undefined);
	assert.equal(await reloaded.get("b") !== undefined, true);
});

test("list filters by cwd and sorts by updatedAt descending", async () => {
	const store = new SessionMapStore(await tempMapPath(), LOGGER);
	await store.put(record("old", { cwd: "/tmp/p", updatedAt: "2025-01-01T00:00:01.000Z" }));
	await store.put(record("new", { cwd: "/tmp/p", updatedAt: "2025-06-01T00:00:00.000Z" }));
	await store.put(record("elsewhere", { cwd: "/tmp/q" }));

	assert.deepEqual(
		(await store.list("/tmp/p")).map((r) => r.sessionId),
		["new", "old"],
	);
	assert.equal((await store.list()).length, 3);
});

test("touch updates timestamp and optional title without a full rewrite", async () => {
	const store = new SessionMapStore(await tempMapPath(), LOGGER);
	await store.put(record("a", { title: "before" }));
	await new Promise((resolve) => setTimeout(resolve, 5));
	await store.touch("a", "after");
	const updated = await store.get("a");
	assert.equal(updated?.title, "after");
	assert.ok(updated!.updatedAt > "2025-01-01T00:00:00.000Z");
});

test("corrupt map file starts empty instead of throwing", async () => {
	const path = await tempMapPath();
	await writeFile(path, "{ not json", "utf8");
	const store = new SessionMapStore(path, LOGGER);
	assert.deepEqual(await store.list(), []);
});

test("unknown map version is ignored", async () => {
	const path = await tempMapPath();
	await writeFile(path, JSON.stringify({ version: 99, sessions: [record("a")] }), "utf8");
	const store = new SessionMapStore(path, LOGGER);
	assert.equal(await store.get("a"), undefined);
});

test("persisted file is valid version-1 JSON", async () => {
	const path = await tempMapPath();
	const store = new SessionMapStore(path, LOGGER);
	await store.put(record("a", { title: undefined }));
	const parsed = JSON.parse(await readFile(path, "utf8"));
	assert.equal(parsed.version, 1);
	assert.equal(parsed.sessions.length, 1);
	assert.equal(parsed.sessions[0].sessionId, "a");
});
