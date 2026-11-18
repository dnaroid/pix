import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSupervisorOpenRequest, parseSupervisorToolRequest, SUPERVISOR_RESPONSE_PREFIX } from "../src/acp/supervisor-contract.js";
import { forwardSupervisorRequest } from "../src/acp/supervisor-bridge.js";
import {
	createSupervisorService,
	digestMessages,
	readSessionBranchMessages,
	type SupervisorLiveSession,
	type SupervisorSessionRecord,
	type TaskLink,
} from "../src/acp/supervisor-service.js";
import { createSupervisorStore } from "../src/acp/supervisor-store.js";
import { createSupervisorBridge, handleSupervisorResponse, installSupervisorHost } from "../src/pi/supervisor-host.js";
import type { Logger } from "../src/logging.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function project(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pix-supervisor-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

function record(sessionId: string, cwd: string, extra: Partial<SupervisorSessionRecord> = {}): SupervisorSessionRecord {
	return { sessionId, cwd, piSessionPath: join(cwd, `${sessionId}.jsonl`), updatedAt: "2026-11-18T00:00:00.000Z", ...extra };
}

test("supervisor contract accepts only status and read with a session id", () => {
	assert.deepEqual(parseSupervisorToolRequest({ op: "status" }), { op: "status" });
	assert.deepEqual(parseSupervisorToolRequest({ op: "read", sessionId: " w1 " }), { op: "read", sessionId: "w1" });
	for (const bad of [{ op: "start" }, { op: "read" }, { op: "status", sessionId: "x" }, { op: "read", sessionId: "x".repeat(200) }, null]) {
		assert.throws(() => parseSupervisorToolRequest(bad));
	}
	assert.throws(() => parseSupervisorOpenRequest({ cwd: "" }));
});

test("supervisor service answers only the registered supervisor and reports sessions read-only", async (t) => {
	const cwd = await project(t);
	const store = createSupervisorStore();
	await store.updateRegistry(cwd, (current) => ({
		...current,
		supervisorSessionId: "sup",
		sessions: { managed: { item: { kind: "task", taskId: "t1" }, mode: "managed", registeredAt: 1, reworkRounds: 2 } },
	}));
	const records = [record("sup", cwd), record("managed", cwd, { title: "Fix bug" }), record("manual", cwd), record("child", cwd, { subagent: {} })];
	const live = new Map<string, SupervisorLiveSession>([
		["managed", { running: true, pendingQuestions: 0, messages: async () => [] }],
		["manual", { running: true, pendingQuestions: 1, messages: async () => [] }],
	]);
	const service = createSupervisorService({
		store,
		listRecords: async () => records,
		getRecord: async (id) => records.find((row) => row.sessionId === id),
		live: (id) => live.get(id),
		touchedFiles: () => [],
		planFor: async (_cwd, id) => id === "managed" ? ".pi/plans/p.md" : undefined,
		readPlanProgress: async () => ({ completed: 1, total: 3 }),
		readTaskLinks: async () => new Map<string, TaskLink>([["managed", { taskId: "t1", title: "Fix bug", status: "in-progress" }]]),
	});
	await assert.rejects(service.handle(cwd, "manual", { op: "status" }), /not the project supervisor/);
	service.record({ sessionId: "managed", at: 5, type: "settled", stopReason: "end_turn", touchedFiles: ["a.ts"] });
	const status = await service.handle(cwd, "sup", { op: "status" }) as any;
	assert.equal(status.mandate.enabled, false);
	assert.equal(status.mandate.budgetTokens, null);
	assert.deepEqual(status.limits, { running: 1, maxConcurrent: 5 });
	assert.equal(status.managed.length, 1);
	assert.deepEqual(status.managed[0], {
		sessionId: "managed", title: "Fix bug",
		managed: { item: { kind: "task", taskId: "t1" }, mode: "managed", reworkRounds: 2 },
		task: { taskId: "t1", title: "Fix bug", status: "in-progress" },
		run: "running", last: { type: "settled", at: 5, stopReason: "end_turn" },
		plan: { path: ".pi/plans/p.md", progress: { completed: 1, total: 3 } },
		updatedAt: "2026-11-18T00:00:00.000Z",
	});
	// The supervisor itself, sub-agent viewers and managed sessions are not "observed".
	assert.deepEqual(status.observed.map((row: { sessionId: string; run: string }) => [row.sessionId, row.run]), [["manual", "question"]]);
	await assert.rejects(service.handle(cwd, "sup", { op: "read", sessionId: "sup" }), /worker sessions/);
	await assert.rejects(service.handle(cwd, "sup", { op: "read", sessionId: "child" }), /Unknown session/);
	await assert.rejects(service.handle(cwd, "sup", { op: "read", sessionId: "missing" }), /Unknown session/);
});

test("supervisor read returns a bounded digest from the live runtime or the saved transcript", async (t) => {
	const cwd = await project(t);
	const store = createSupervisorStore();
	await store.updateRegistry(cwd, (current) => ({ ...current, supervisorSessionId: "sup" }));
	const saved = record("saved", cwd);
	const lines = [
		{ type: "session", id: "h" },
		{ type: "message", id: "1", parentId: null, message: { role: "user", content: [{ type: "text", text: "first" }] } },
		{ type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
		{ type: "message", id: "3", parentId: "1", message: { role: "toolResult", toolName: "Bash", isError: true, content: [{ type: "text", text: "exit 1" }] } },
		{ type: "message", id: "4", parentId: "3", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done.\n## Verification\nnpm test" }] } },
	];
	await writeFile(saved.piSessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"torn`, "utf8");
	const service = createSupervisorService({
		store,
		listRecords: async () => [saved],
		getRecord: async (id) => id === "saved" ? saved : undefined,
		live: () => undefined,
		touchedFiles: () => Array.from({ length: 150 }, (_, i) => `f${i}.ts`),
		planFor: async () => undefined,
		readTaskLinks: async () => new Map(),
	});
	const digest = await service.handle(cwd, "sup", { op: "read", sessionId: "saved" }) as any;
	assert.equal(digest.run, "not-loaded");
	assert.equal(digest.pendingQuestion, false);
	assert.deepEqual(digest.lastUserMessages, ["first"]);
	assert.deepEqual(digest.finalReport, { text: "Done.\n## Verification\nnpm test", stopReason: "stop" });
	assert.deepEqual(digest.toolErrors, [{ tool: "Bash", text: "exit 1" }]);
	assert.equal(digest.messageCount, 3, "only the current branch is digested");
	assert.equal(digest.touchedFiles.length, 100);
	assert.equal(digest.touchedFilesTotal, 150);
	assert.equal(digest.touchedFiles.at(-1), "f149.ts");
});

test("digest clips long text and keeps only the latest user messages", () => {
	const long = "x".repeat(10_000);
	const digest = digestMessages([
		{ role: "user", content: "one" }, { role: "user", content: "two" }, { role: "user", content: long },
		{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: long }] },
	]);
	assert.equal(digest.lastUserMessages.length, 2);
	assert.equal(digest.lastUserMessages[0], "two");
	assert.ok(digest.lastUserMessages[1]!.length <= 1_501);
	assert.ok(digest.finalReport!.text.length <= 4_001);
	assert.ok(!digest.finalReport!.text.includes("hidden"));
});

test("saved transcript reader rejects non-files", async (t) => {
	const cwd = await project(t);
	await assert.rejects(readSessionBranchMessages(cwd), /not a file/);
});

test("supervisor bridge correlates replies per runtime and drops late or foreign replies", async () => {
	const events: any[] = [];
	let id = "owner";
	const bridge = createSupervisorBridge({ sessionManager: { getSessionId: () => id } }, (event: unknown) => events.push(event));
	const a = bridge.request({ ownerSessionId: "owner", op: "status" });
	const b = bridge.request({ ownerSessionId: "owner", op: "read", sessionId: "w" });
	assert.deepEqual(events.map((event) => event.request), [{ op: "status" }, { op: "read", sessionId: "w" }]);
	bridge.respond({ requestId: "foreign", result: 0 });
	bridge.respond({ requestId: events[1].requestId, error: "nope" });
	bridge.respond({ requestId: events[0].requestId, result: { ok: true } });
	assert.deepEqual(await a, { ok: true });
	await assert.rejects(b, /nope/);
	assert.throws(() => bridge.request({ ownerSessionId: "stale", op: "status" }), /replaced/);
	const controller = new AbortController();
	const aborted = bridge.request({ ownerSessionId: "owner", op: "status" }, controller.signal);
	controller.abort();
	await assert.rejects(aborted, /cancelled/);
	const pending = bridge.request({ ownerSessionId: "owner", op: "status" });
	bridge.dispose();
	await assert.rejects(pending, /closed/);
	id = "owner";
	assert.throws(() => bridge.request({ ownerSessionId: "owner", op: "status" }), /replaced/);
});

test("supervisor bridge times out without leaving pending requests", async () => {
	const events: any[] = [];
	const bridge = createSupervisorBridge({ sessionManager: { getSessionId: () => "owner" } }, (event: unknown) => events.push(event), 5);
	await assert.rejects(bridge.request({ ownerSessionId: "owner", op: "status" }), /timed out/);
	bridge.respond({ requestId: events[0].requestId, result: 1 }); // late reply is ignored
});

test("supervisor host installs one global per bound runtime and handles prefixed replies", async () => {
	const key = Symbol.for("pix.supervisor.request");
	const previous = (globalThis as any)[key];
	const emitted: any[] = [];
	class Session {
		sessionManager = { getSessionId: () => "owner" };
		bindExtensions(_bindings: unknown) { return "bound"; }
		dispose() { return "disposed"; }
		_emit(event: unknown) { emitted.push(event); }
	}
	installSupervisorHost(Session);
	installSupervisorHost(Session); // idempotent
	const session = new Session();
	try {
		assert.equal(session.bindExtensions({}), "bound");
		const pending = (globalThis as any)[key]({ ownerSessionId: "owner", op: "status" });
		let handled = "";
		assert.equal(handleSupervisorResponse(session, SUPERVISOR_RESPONSE_PREFIX + JSON.stringify({ requestId: emitted[0].requestId, result: { n: 1 } }), {
			preflightResult: (value: string) => { handled = value; },
		}), true);
		assert.equal(handled, "handled");
		assert.deepEqual(await pending, { n: 1 });
		assert.equal(handleSupervisorResponse(session, "ordinary prompt"), false);
		assert.throws(() => handleSupervisorResponse(session, `${SUPERVISOR_RESPONSE_PREFIX}{}`), /Invalid/);
		session.dispose();
		assert.equal((globalThis as any)[key], undefined);
	} finally {
		if (previous) (globalThis as any)[key] = previous;
	}
});

test("ACP forwards supervisor requests and never answers a replaced runtime", async () => {
	const replies: unknown[] = [];
	const session = { acpSessionId: "sup", cwd: "/p", pi: { respondToSupervisor: async (requestId: string, response: unknown) => { replies.push([requestId, response]); } } };
	await forwardSupervisorRequest(session, { requestId: "r1", request: { op: "status" } },
		async (cwd, caller, request) => ({ cwd, caller, request }), () => true, logger);
	assert.deepEqual(replies, [["r1", { result: { cwd: "/p", caller: "sup", request: { op: "status" } } }]]);
	await forwardSupervisorRequest(session, { requestId: "r2", request: { op: "start" } }, async () => 1, () => true, logger);
	assert.match((replies[1] as any)[1].error, /Unknown supervisor op/);
	let current = true;
	await forwardSupervisorRequest(session, { requestId: "r3", request: { op: "status" } },
		async () => { current = false; return 1; }, () => current, logger);
	assert.equal(replies.length, 2);
});
