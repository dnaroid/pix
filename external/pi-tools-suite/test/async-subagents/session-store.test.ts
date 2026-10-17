import { afterEach, expect, test } from "bun:test";
import { runKey } from "../../src/async-subagents/core/paths.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";
import {
	SUBAGENT_RECORD_ENTRY, findLatestAgentRecord, getLive, getRecord, hydrateFromManager,
	resetSubagentStoreForTest, updateLive, updateRecord,
} from "../../src/async-subagents/core/store.js";

const cwd = "/session-store-fixture";
const scope = "11111111-1111-4111-8111-111111111111";
const key = (batch: string) => runKey(cwd, scope, batch);
const entry = (batch: string, patch: Record<string, unknown>) => ({
	type: "custom", customType: SUBAGENT_RECORD_ENTRY,
	data: { version: 1, scope, batch, agentId: "agent", cwd, ...patch },
});
const manager = (entries: ReturnType<typeof entry>[]) => ({
	getEntries: () => entries, getCwd: () => cwd, getSessionId: () => scope,
});
afterEach(resetSubagentStoreForTest);

test("hydration folds patches and null deletions without using last-update order for lookup", () => {
	const entries = [
		entry("old", { status: "running", pid: 123, createdAt: "2026-01-01T00:00:00Z" }),
		entry("new", { status: "done", createdAt: "2026-01-02T00:00:00Z" }),
		entry("old", { status: "failed", exitCode: 1, pid: null }),
	];
	hydrateFromManager(manager(entries));
	expect(getRecord(key("old"), "agent")).toMatchObject({ status: "failed", exitCode: 1 });
	expect(getRecord(key("old"), "agent")?.pid).toBeUndefined();
	expect(findLatestAgentRecord(cwd, scope, "agent")?.batch).toBe("new");
});

test("equal launch timestamps use launch entry order and never cross parent scopes", () => {
	hydrateFromManager(manager([
		entry("old", { createdAt: "2026-01-01T00:00:00Z" }),
		entry("new", { createdAt: "2026-01-01T00:00:00Z" }),
		entry("old", { status: "done" }),
	]));
	expect(findLatestAgentRecord(cwd, scope, "agent")?.batch).toBe("new");
	expect(findLatestAgentRecord(cwd, "22222222-2222-4222-8222-222222222222", "agent")).toBeUndefined();
});

test("hydration never overwrites an owned live record or its transient overlay", () => {
	updateRecord(key("batch"), "agent", { status: "running" });
	updateLive(key("batch"), "agent", { active: true, resultText: "live answer" });
	hydrateFromManager(manager([entry("batch", { status: "failed" })]));
	expect(getRecord(key("batch"), "agent")?.status).toBe("running");
	expect(getLive(key("batch"), "agent")?.resultText).toBe("live answer");
});

test("durable writer persists compact patches but never process handles or full result text", () => {
	const entries: ReturnType<typeof entry>[] = [];
	const writer = { appendCustomEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data } as ReturnType<typeof entry>); } };
	updateRecord(key("batch"), "agent", { status: "running", pid: 123 }, writer);
	updateLive(key("batch"), "agent", { active: true, resultText: "not durable", stderrTail: "not durable" });
	updateRecord(key("batch"), "agent", { status: "done", exitCode: 0, pid: null });
	expect(entries).toHaveLength(2);
	expect(JSON.stringify(entries)).not.toContain("not durable");
	resetSubagentStoreForTest();
	hydrateFromManager(manager(entries));
	expect(getRecord(key("batch"), "agent")?.status).toBe("done");
	expect(getRecord(key("batch"), "agent")?.pid).toBeUndefined();
	expect(getLive(key("batch"), "agent")).toBeUndefined();
});

test("failed hydration is surfaced and the same manager can retry after storage recovers", () => {
	let failed = true;
	const reader = { ...manager([]), getEntries() { if (failed) throw new Error("controlled read failure"); return [entry("batch", { status: "done" })]; } };
	expect(() => hydrateFromManager(reader)).toThrow("controlled read failure");
	failed = false;
	hydrateFromManager(reader);
	expect(getRecord(key("batch"), "agent")?.status).toBe("done");
});

test("external readers preserve planned/retrying only while the owning runtime is alive", () => {
	for (const status of ["planned", "retrying"] as const) {
		updateRecord(key(status), "agent", { status, ownerPid: process.pid, nextRetryAt: "2026-01-02T00:00:00Z" });
		expect(getAgentState(key(status), "agent")?.status).toBe(status);
		if (status === "retrying") expect(getAgentState(key(status), "agent")?.nextRetryAt).toBe("2026-01-02T00:00:00Z");
		updateRecord(key(status), "agent", { ownerPid: 2147483647 });
		expect(getAgentState(key(status), "agent")?.status).toBe("stopped");
		updateRecord(key(status), "agent", { ownerPid: process.pid, stopRequested: true });
		expect(getAgentState(key(status), "agent")?.status).toBe("stopped");
	}
});
