import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEvent } from "../src/acp/session-events.js";
import { reconcileSupervisor, turnInterrupted } from "../src/acp/supervisor-reconcile.js";
import { createSupervisorStore, type ManagedSession } from "../src/acp/supervisor-store.js";

const entry: ManagedSession = { item: { kind: "prompt" }, mode: "managed", registeredAt: 1, reworkRounds: 0 };

test("turnInterrupted detects a saved branch that ends inside a turn", () => {
	assert.equal(turnInterrupted([]), false);
	assert.equal(turnInterrupted([{ role: "user" }]), true);
	assert.equal(turnInterrupted([{ role: "user" }, { role: "assistant", stopReason: "toolUse" }]), true);
	assert.equal(turnInterrupted([{ role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }]), true);
	assert.equal(turnInterrupted([{ role: "user" }, { role: "assistant", stopReason: "stop" }]), false);
	assert.equal(turnInterrupted([{ role: "user" }, { role: "assistant", stopReason: "aborted" }]), false);
});

test("reconcile reports interrupted and missing sessions without changing the registry", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pix-supervisor-reconcile-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const store = createSupervisorStore();
	const sessions = { done: entry, cut: entry, gone: entry, live: entry, broken: entry };
	await store.updateRegistry(cwd, () => ({ version: 1, supervisorSessionId: "sup", sessions }));
	const transcripts: Record<string, unknown[]> = {
		done: [{ role: "user" }, { role: "assistant", stopReason: "stop" }],
		cut: [{ role: "user" }, { role: "assistant", stopReason: "toolUse" }],
		live: [{ role: "user" }],
	};
	const events: SessionEvent[] = [];
	const reports: string[] = [];
	const result = await reconcileSupervisor(cwd, {
		store,
		record: async (_cwd, sessionId) => sessionId === "gone" ? undefined : { piSessionPath: sessionId },
		messages: async (path) => {
			if (path === "broken") throw new Error("unreadable");
			return transcripts[path] ?? [];
		},
		running: (sessionId) => sessionId === "live",
		emit: (event) => events.push(event),
		report: (message) => reports.push(message),
	});
	assert.deepEqual(result, { interrupted: ["cut"], missing: ["gone"] });
	assert.deepEqual(events.map((event) => [event.type, event.sessionId]), [["interrupted", "cut"], ["missing", "gone"]]);
	assert.equal(reports.length, 1);
	assert.deepEqual(Object.keys((await store.readRegistry(cwd)).sessions).sort(), Object.keys(sessions).sort());
	assert.deepEqual((await store.readLedger(cwd)).map((row) => row.kind), ["reconciled"]);
});

test("reconcile with nothing to report writes no ledger entry", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pix-supervisor-reconcile-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const store = createSupervisorStore();
	await store.updateRegistry(cwd, () => ({ version: 1, sessions: { ok: entry } }));
	const result = await reconcileSupervisor(cwd, {
		store, record: async () => ({ piSessionPath: "p" }), messages: async () => [{ role: "assistant", stopReason: "stop" }],
		running: () => false, emit: () => assert.fail("no event expected"), report: () => {},
	});
	assert.deepEqual(result, { interrupted: [], missing: [] });
	assert.deepEqual(await store.readLedger(cwd), []);
});
