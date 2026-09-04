import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
		// The store persists resolve()d pi session paths; apply the same
		// transform here so records and expectations match on every platform
		// (Windows resolves /tmp/... literals to <drive>:\tmp\...).
		piSessionPath: resolve(`/tmp/pi-sessions/${sessionId}.jsonl`),
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
	assert.equal((await reloaded.get("a"))?.piSessionPath, resolve("/tmp/pi-sessions/a.jsonl"));
	assert.deepEqual((await reloaded.list()).map((r) => r.sessionId), ["a", "b"]);

	await reloaded.delete("a");
	assert.equal(await reloaded.get("a"), undefined);
	assert.equal(await reloaded.get("b") !== undefined, true);
});

test("put atomically replaces another id mapped to the same Pi session path", async () => {
	const store = new SessionMapStore(await tempMapPath(), LOGGER);
	await store.mergeByPiSessionPath([record("native-id", { piSessionPath: resolve("/tmp/shared.jsonl") })]);
	await store.put(record("acp-id", { piSessionPath: resolve("/tmp/shared.jsonl"), piSessionId: "native-id" }));
	await store.mergeByPiSessionPath([record("native-id", { piSessionPath: resolve("/tmp/shared.jsonl") })]);

	assert.deepEqual((await store.list()).map((item) => item.sessionId), ["acp-id"]);
	assert.equal(await store.get("native-id"), undefined);
});

test("concurrent mutations preserve every session", async () => {
	const path = await tempMapPath();
	const store = new SessionMapStore(path, LOGGER);
	await Promise.all([store.put(record("a")), store.put(record("b")), store.put(record("c"))]);

	const reloaded = new SessionMapStore(path, LOGGER);
	assert.deepEqual(
		(await reloaded.list()).map((entry) => entry.sessionId).sort(),
		["a", "b", "c"],
	);
});

test("concurrent adapter processes merge mutations through the file lock", async () => {
	const path = await tempMapPath();
	const first = new SessionMapStore(path, LOGGER);
	const second = new SessionMapStore(path, LOGGER);
	await Promise.all([first.put(record("a")), second.put(record("b"))]);

	const reloaded = new SessionMapStore(path, LOGGER);
	assert.deepEqual(
		(await reloaded.list()).map((entry) => entry.sessionId).sort(),
		["a", "b"],
	);
});

test("long-lived stores refresh reads after another process writes", async () => {
	const path = await tempMapPath();
	const first = new SessionMapStore(path, LOGGER);
	const second = new SessionMapStore(path, LOGGER);
	await first.put(record("a"));
	assert.equal((await second.list()).length, 1);
	await first.put(record("b"));
	assert.deepEqual(
		(await second.list()).map((entry) => entry.sessionId).sort(),
		["a", "b"],
	);
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

test("native reconciliation deduplicates by path and preserves the existing ACP id", async () => {
	const store = new SessionMapStore(await tempMapPath(), LOGGER);
	await store.put(record("acp-existing", {
		piSessionPath: resolve("/tmp/pi-sessions/native.jsonl"),
		piSessionId: "old-native-id",
		title: "Old title",
	}));

	await store.mergeByPiSessionPath([record("native-id", {
		piSessionPath: resolve("/tmp/pi-sessions/native.jsonl"),
		piSessionId: "native-id",
		title: "Native title",
		updatedAt: "2025-06-01T00:00:00.000Z",
	})]);

	const records = await store.list();
	assert.equal(records.length, 1);
	assert.deepEqual(records[0], record("acp-existing", {
		piSessionPath: resolve("/tmp/pi-sessions/native.jsonl"),
		piSessionId: "native-id",
		title: "Native title",
		updatedAt: "2025-06-01T00:00:00.000Z",
	}));
});

test("native reconciliation repairs duplicate paths from an older map", async () => {
	const path = await tempMapPath();
	const sharedPath = resolve("/tmp/pi-sessions/duplicate.jsonl");
	await writeFile(path, JSON.stringify({
		version: 1,
		sessions: [
			record("native-id", { piSessionPath: sharedPath, piSessionId: "native-id" }),
			record("acp-id", { piSessionPath: sharedPath, piSessionId: "native-id" }),
		],
	}), "utf8");
	const store = new SessionMapStore(path, LOGGER);

	await store.mergeByPiSessionPath([
		record("native-id", { piSessionPath: sharedPath, piSessionId: "native-id" }),
	]);

	assert.deepEqual((await store.list()).map((item) => item.sessionId), ["acp-id"]);
});

test("native reconciliation assigns a stable fallback when a Pi id collides", async () => {
	const store = new SessionMapStore(await tempMapPath(), LOGGER);
	await store.put(record("same-id", { piSessionPath: resolve("/tmp/pi-sessions/first.jsonl") }));
	const discovered = record("same-id", {
		piSessionPath: resolve("/tmp/pi-sessions/second.jsonl"),
		piSessionId: "same-id",
	});

	await store.mergeByPiSessionPath([discovered]);
	const firstIds = (await store.list()).map((item) => item.sessionId).sort();
	assert.equal(firstIds.length, 2);
	assert.ok(firstIds.some((id) => id.startsWith("pi-") && id !== "same-id"));

	await store.mergeByPiSessionPath([discovered]);
	assert.deepEqual((await store.list()).map((item) => item.sessionId).sort(), firstIds);
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

test("mutations do not overwrite an invalid or future-version map", async () => {
	for (const contents of ["not json", JSON.stringify({ version: 99, sessions: [] })]) {
		const path = await tempMapPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents, "utf8");
		const store = new SessionMapStore(path, LOGGER);

		await assert.rejects(store.put(record("new")), /refusing to overwrite invalid session map/);
		assert.equal(await readFile(path, "utf8"), contents);
	}
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
