import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSupervisorStore,
	DEFAULT_MANDATE,
	MAX_MANAGED_SESSIONS,
	parseMandate,
	SUPERVISOR_DIR,
} from "../src/acp/supervisor-store.js";

function project(): string {
	return mkdtempSync(join(tmpdir(), "pix-supervisor-store-"));
}

test("missing state reads as defaults and creates nothing", async () => {
	const cwd = project();
	const store = createSupervisorStore();
	assert.deepEqual(await store.readMandate(cwd), DEFAULT_MANDATE);
	assert.deepEqual((await store.readRegistry(cwd)).sessions, {});
	assert.deepEqual(await store.readLedger(cwd), []);
	assert.deepEqual(readdirSync(cwd), []);
});

test("mandate patches are clamped, persisted and leave no temp files", async () => {
	const cwd = project();
	const store = createSupervisorStore({ now: () => 42 });
	const saved = await store.updateMandate(cwd, { enabled: true, maxConcurrent: 99, stalledAfterMinutes: 1, budgetTokens: 1_000_000, policy: "no db" });
	assert.equal(saved.maxConcurrent, 20);
	assert.equal(saved.stalledAfterMinutes, 5);
	assert.equal(saved.budgetTokens, 1_000_000);
	assert.equal(saved.updatedAt, 42);
	assert.deepEqual(await createSupervisorStore().readMandate(cwd), saved);
	assert.deepEqual(readdirSync(join(cwd, SUPERVISOR_DIR)).sort(), ["mandate.json"]);
});

test("a malformed pause flag reads as paused", () => {
	assert.equal(parseMandate({ paused: "yes" }).paused, true);
	assert.equal(parseMandate({}).paused, false);
});

test("concurrent registry updates are serialized and bounded", async () => {
	const cwd = project();
	const store = createSupervisorStore();
	await Promise.all(Array.from({ length: MAX_MANAGED_SESSIONS + 5 }, (_, i) => store.updateRegistry(cwd, (current) => ({
		...current,
		sessions: { ...current.sessions, [`s${i}`]: { item: { kind: "prompt" }, mode: "managed", registeredAt: i, reworkRounds: 0 } },
	}))));
	const registry = await store.readRegistry(cwd);
	assert.equal(Object.keys(registry.sessions).length, MAX_MANAGED_SESSIONS);
	assert.equal(registry.sessions["s0"], undefined, "oldest dropped");
	assert.ok(registry.sessions[`s${MAX_MANAGED_SESSIONS + 4}`]);
});

test("invalid registry records are dropped", async () => {
	const cwd = project();
	mkdirSync(join(cwd, SUPERVISOR_DIR), { recursive: true });
	writeFileSync(join(cwd, SUPERVISOR_DIR, "registry.json"), JSON.stringify({
		supervisorSessionId: "sup",
		sessions: { a: { item: { kind: "task", taskId: "t1" }, mode: "manual" }, b: { item: { kind: "bogus" } }, c: 3 },
	}));
	const registry = await createSupervisorStore().readRegistry(cwd);
	assert.equal(registry.supervisorSessionId, "sup");
	assert.deepEqual(Object.keys(registry.sessions), ["a"]);
	assert.equal(registry.sessions["a"]?.mode, "manual");
});

test("ledger appends in order and skips a torn line", async () => {
	const cwd = project();
	let clock = 0;
	const store = createSupervisorStore({ now: () => ++clock });
	await Promise.all([1, 2, 3].map((n) => store.appendLedger(cwd, { kind: "note", detail: { n } })));
	appendFileSync(join(cwd, SUPERVISOR_DIR, "ledger.jsonl"), "{\"at\":9,\"kin");
	const entries = await store.readLedger(cwd);
	assert.deepEqual(entries.map((entry) => entry.detail?.["n"]), [1, 2, 3]);
	assert.deepEqual((await store.readLedger(cwd, 2)).map((entry) => entry.at), [2, 3]);
});
