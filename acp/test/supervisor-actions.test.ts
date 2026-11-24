import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { completionGuardFailures, createSupervisorActions, runningManagedSessions } from "../src/acp/supervisor-actions.js";
import { SUPERVISOR_WORKER_PREAMBLE, type SupervisorMutation, type SupervisorStartItem } from "../src/acp/supervisor-contract.js";
import type { SupervisorDigest, SupervisorLiveSession, SupervisorPendingQuestion } from "../src/acp/supervisor-service.js";
import { createSupervisorStore, type ManagedSession, type SupervisorMandate } from "../src/acp/supervisor-store.js";

const SUPERVISOR = "sup";

function managed(extra: Partial<ManagedSession> = {}): ManagedSession {
	return { item: { kind: "task", taskId: "task-1" }, mode: "managed", registeredAt: 1, reworkRounds: 0, ...extra };
}

function liveSession(running = false, pendingQuestions = 0): SupervisorLiveSession {
	return { running, pendingQuestions, messages: async () => [] };
}

function goodDigest(sessionId: string, extra: Partial<SupervisorDigest> = {}): SupervisorDigest {
	return {
		sessionId, run: "idle", pendingQuestion: false,
		plan: { path: ".pi/plans/p.md", progress: { completed: 3, total: 3 } },
		finalReport: { text: "Done.\n\n## Verification\n- tests pass", stopReason: "stop" },
		touchedFiles: ["a.ts"], touchedFilesTotal: 1, lastUserMessages: [], toolErrors: [], messageCount: 4,
		...extra,
	};
}

/** Per-project FIFO lock, the same contract ACP's `supervisorExclusive` provides. */
function lock() {
	const tails = new Map<string, Promise<unknown>>();
	return <T>(cwd: string, operation: () => Promise<T>): Promise<T> => {
		const run = (tails.get(cwd) ?? Promise.resolve()).then(operation, operation);
		tails.set(cwd, run.catch(() => {}));
		return run;
	};
}

async function setup(
	t: { after(fn: () => Promise<void>): void },
	options: { mandate?: Partial<Omit<SupervisorMandate, "version" | "updatedAt">>; sessions?: Record<string, ManagedSession>; standardWorkerModel?: () => Promise<string | undefined> } = {},
) {
	const cwd = await mkdtemp(join(tmpdir(), "pix-supervisor-actions-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const store = createSupervisorStore();
	await store.updateMandate(cwd, { enabled: true, ...options.mandate });
	await store.updateRegistry(cwd, () => ({ version: 1, supervisorSessionId: SUPERVISOR, sessions: options.sessions ?? { w1: managed() } }));
	const live = new Map<string, SupervisorLiveSession>([["w1", liveSession()]]);
	const digests = new Map<string, SupervisorDigest>();
	const stops = new Map<string, string>();
	const delivered: { sessionId: string; text: string }[] = [];
	const questions = new Map<string, SupervisorPendingQuestion>();
	const answers: unknown[] = [];
	let userPromptAt: number | undefined;
	const cancelled: string[] = [];
	const taskWrites: { taskId: string; status: string }[] = [];
	const released: string[] = [];
	const autoClosed: string[] = [];
	let catalogRefreshes = 0;
	const gone = new Set<string>();
	const launches: { item: SupervisorStartItem; modelRef: string | undefined; caller: string }[] = [];
	let launchGate: (() => Promise<void>) | undefined;
	let launchError: Error | undefined;
	const exclusive = lock();
	const actions = createSupervisorActions({
		store,
		standardWorkerModel: options.standardWorkerModel ?? (async () => undefined),
		runtime: {
			exclusive,
			deliver: async (sessionId, text) => {
				delivered.push({ sessionId, text });
				return live.get(sessionId)?.running ? "steering" : "queued";
			},
			question: (sessionId, questionId) => questions.get(sessionId)?.questionId === questionId ? questions.get(sessionId) : undefined,
			answerQuestion: (sessionId, questionId, value) => {
				answers.push({ sessionId, questionId, value: JSON.parse(value) });
				questions.delete(sessionId);
			},
			userPromptAt: () => userPromptAt,
			cancel: (sessionId) => { cancelled.push(sessionId); },
			launch: async (_cwd, caller, item, modelRef) => {
				launches.push({ item, modelRef, caller });
				await launchGate?.();
				if (launchError) throw launchError;
				const sessionId = `new${launches.length}`;
				live.set(sessionId, liveSession(true));
				return { sessionId };
			},
			writeTaskStatus: async (_cwd, taskId, status) => { taskWrites.push({ taskId, status }); return true; },
			released: (sessionId) => { released.push(sessionId); },
			autoCloseTab: (_cwd, _caller, sessionId) => { autoClosed.push(sessionId); },
			registered: () => { catalogRefreshes++; },
		},
		live: (sessionId) => live.get(sessionId),
		digest: async (_cwd, _caller, sessionId) => digests.get(sessionId) ?? goodDigest(sessionId),
		lastStopReason: (sessionId) => stops.get(sessionId),
		sessionExists: async (_cwd, sessionId) => !gone.has(sessionId),
	});
	const handle = (request: SupervisorMutation, caller = SUPERVISOR, current?: () => boolean) => actions.handle(cwd, caller, request, current);
	const ledger = async () => (await store.readLedger(cwd)).map((entry) => entry.kind);
	return { cwd, store, live, digests, stops, delivered, cancelled, taskWrites, released, autoClosed, gone, exclusive, handle, ledger, launches,
		catalogRefreshes: () => catalogRefreshes,
		questions, answers, setUserPromptAt: (at: number) => { userPromptAt = at; },
		gate: (gate: () => Promise<void>) => { launchGate = gate; }, failLaunch: (error: Error | undefined) => { launchError = error; } };
}

const send = (text = "please fix", kind: "rework" | "answer" | "note" = "note"): SupervisorMutation => ({ op: "send", sessionId: "w1", text, kind });

test("supervisor mutations need an enabled, unpaused mandate; escalate still works while paused", async (t) => {
	const off = await setup(t, { mandate: { enabled: false } });
	await assert.rejects(off.handle(send()), /not enabled/);
	const paused = await setup(t, { mandate: { paused: true } });
	await assert.rejects(paused.handle(send()), /paused/);
	await assert.rejects(paused.handle({ op: "cancel", sessionId: "w1" }), /paused/);
	await assert.rejects(paused.handle({ op: "close", sessionId: "w1", outcome: "failed", summary: "x" }), /paused/);
	assert.equal(paused.delivered.length, 0);
	assert.deepEqual(await paused.handle({ op: "escalate", sessionId: "w1", text: "Need a decision" }), {
		escalated: true, note: "Now ask the user in your reply: state the decision needed, the options and your recommendation.",
	});
	const registry = await paused.store.readRegistry(paused.cwd);
	assert.equal(registry.sessions.w1?.escalation?.text, "Need a decision");
	assert.deepEqual(await paused.ledger(), ["escalated"]);
});

test("supervisor mutations refuse unmanaged, manual and unopened sessions and a replaced caller", async (t) => {
	const s = await setup(t, { sessions: { w1: managed(), w2: managed({ mode: "manual" }), w3: managed() } });
	s.live.set("w2", liveSession());
	await assert.rejects(s.handle({ op: "send", sessionId: "other", text: "x", kind: "note" }), /not managed/);
	await assert.rejects(s.handle({ op: "send", sessionId: "w2", text: "x", kind: "note" }), /taken over by the user/);
	await assert.rejects(s.handle({ op: "cancel", sessionId: "w2" }), /taken over by the user/);
	await assert.rejects(s.handle({ op: "close", sessionId: "w2", outcome: "done", summary: "x" }), /taken over by the user/);
	await assert.rejects(s.handle({ op: "send", sessionId: "w3", text: "x", kind: "note" }), /not open/);
	await assert.rejects(s.handle(send(), "old-supervisor"), /no longer the project supervisor/);
	await assert.rejects(s.handle({ op: "escalate", text: "x" }, "old-supervisor"), /no longer the project supervisor/);
	assert.equal(s.delivered.length, 0);
	assert.deepEqual(await s.ledger(), []);
});

test("supervisor send labels the message, counts rework and clears the escalation", async (t) => {
	const s = await setup(t, { mandate: { maxReworkRounds: 1 }, sessions: { w1: managed({ escalation: { text: "wait", at: 1 } }) } });
	assert.deepEqual(await s.handle(send("add tests", "rework")), { sent: true, disposition: "queued", reworkRounds: 1, maxReworkRounds: 1 });
	// Only the first supervisor message carries the worker rules.
	assert.deepEqual(s.delivered, [{ sessionId: "w1", text: `${SUPERVISOR_WORKER_PREAMBLE}\n\n[Supervisor rework] add tests` }]);
	const registry = await s.store.readRegistry(s.cwd);
	assert.equal(registry.sessions.w1?.briefed, true);
	assert.equal(registry.sessions.w1?.reworkRounds, 1);
	assert.equal(registry.sessions.w1?.escalation, undefined);
	await assert.rejects(s.handle(send("again", "rework")), /Rework limit reached \(1\/1\)/);
	// Notes do not consume rework rounds.
	await s.handle(send("fyi"));
	assert.equal(s.delivered.at(-1)?.text, "[Supervisor] fyi");
	assert.deepEqual(await s.ledger(), ["sent", "sent"]);
});

const questionnaire: SupervisorPendingQuestion = { questionId: "q1", questions: [
	{ id: "scope", label: "Scope", prompt: "Which scope?", choices: [{ value: "small", label: "Small" }, { value: "all", label: "All" }] },
	{ id: "checks", label: "Checks", prompt: "Which checks?", multiple: true, minSelections: 2, maxSelections: 2,
		choices: [{ value: "unit", label: "Unit" }, { value: "types", label: "Types" }] },
] };
const answer = { op: "answer", sessionId: "w1", questionId: "q1", authority: "mandate", rationale: "Routine test coverage",
	selections: [{ id: "checks", choiceValues: ["unit"], customText: "Smoke check" }, { id: "scope", choiceValue: "small" }] } satisfies SupervisorMutation;

test("supervisor answers are gated by the mandate, managed mode and caller runtime", async (t) => {
	for (const [options, error] of [
		[{ mandate: { enabled: false } }, /not enabled/],
		[{ mandate: { paused: true } }, /paused/],
		[{ sessions: { w1: managed({ mode: "manual" }) } }, /manual/],
		[{ sessions: {} }, /not managed/],
	] as const) {
		const s = await setup(t, options);
		s.questions.set("w1", questionnaire);
		await assert.rejects(s.handle(answer), error);
		assert.deepEqual(s.answers, []);
		assert.deepEqual(await s.ledger(), []);
	}
	const s = await setup(t);
	s.questions.set("w1", questionnaire);
	await assert.rejects(s.handle(answer, SUPERVISOR, () => false), /no longer the project supervisor/);
	assert.deepEqual(s.answers, []);
});

test("supervisor answer validates selections and rejects stale and duplicate submissions without sending a message", async (t) => {
	const s = await setup(t, { mandate: { maxConcurrent: 1, maxReworkRounds: 0 } });
	s.live.set("w1", liveSession(true, 1));
	s.questions.set("w1", questionnaire);
	await assert.rejects(s.handle(send("small", "answer")), /op=answer/);
	await assert.rejects(s.handle({ ...answer, questionId: "old" }), /stale/);
	await assert.rejects(s.handle({ ...answer, selections: [{ id: "scope", choiceValue: "small" }] }), /exactly one/);
	for (const selections of [
		[{ id: "scope", choiceValue: "Small" }, answer.selections[0]!],
		[{ id: "scope", customText: "Custom scope" }, { id: "checks", choiceValues: ["unit"] }],
		[{ id: "scope", customText: "Custom scope" }, { id: "checks", choiceValues: ["unit", "unit"] }],
	]) await assert.rejects(s.handle({ ...answer, selections }), /Invalid selection/);
	assert.deepEqual(s.answers, []);
	assert.deepEqual(await s.handle(answer), { answered: true, questionId: "q1" });
	assert.deepEqual(s.answers, [{ sessionId: "w1", questionId: "q1", value: { version: 1, selections: [...answer.selections].reverse() } }]);
	await assert.rejects(s.handle(answer), /stale/);
	assert.deepEqual(s.delivered, []);
	assert.equal((await s.store.readRegistry(s.cwd)).sessions.w1?.reworkRounds, 0);
	const [entry] = await s.store.readLedger(s.cwd);
	assert.equal(entry?.kind, "answered");
	assert.deepEqual(entry?.detail, { questionId: "q1", authority: answer.authority, rationale: answer.rationale, selections: answer.selections });
});

test("a question escalation survives send and requires a later user prompt for the same live question", async (t) => {
	const s = await setup(t, { mandate: { paused: true } });
	s.questions.set("w1", questionnaire);
	const escalate = { op: "escalate", sessionId: "w1", questionId: "q1", text: "Need a product decision" } as const;
	await assert.rejects(s.handle({ ...escalate, questionId: "old" }), /stale/);
	await s.handle(escalate);
	const escalation = (await s.store.readRegistry(s.cwd)).sessions.w1?.escalation;
	assert.equal(escalation?.questionId, "q1");
	await s.store.updateMandate(s.cwd, { paused: false });
	const relay = { ...answer, authority: "user" } as const;
	await assert.rejects(s.handle(answer), /was escalated/);
	await assert.rejects(s.handle(relay), /subsequent user prompt/);
	await assert.rejects(s.handle({ op: "escalate", sessionId: "w1", text: "generic" }), /already pending/);
	await s.handle(send("status update"));
	assert.deepEqual((await s.store.readRegistry(s.cwd)).sessions.w1?.escalation, escalation);
	s.setUserPromptAt(escalation!.at - 1);
	await assert.rejects(s.handle(relay), /subsequent user prompt/);
	s.setUserPromptAt(escalation!.at + 1);
	await s.handle(relay);
	assert.equal((await s.store.readRegistry(s.cwd)).sessions.w1?.escalation, undefined);
	assert.deepEqual(await s.ledger(), ["escalated", "sent", "answered"]);
});

test("a reissued questionnaire cannot bypass an unresolved escalation", async (t) => {
	const s = await setup(t);
	s.questions.set("w1", questionnaire);
	const escalate = { op: "escalate", sessionId: "w1", questionId: "q1", text: "Need a product decision" } as const;
	await s.handle(escalate);
	s.questions.set("w1", { ...questionnaire, questionId: "q2" });
	await s.handle(send("status update"));
	assert.equal((await s.store.readRegistry(s.cwd)).sessions.w1?.escalation?.questionId, "q1");
	await assert.rejects(s.handle({ ...answer, questionId: "q2" }), /was escalated/);
	const relay = { ...answer, questionId: "q2", authority: "user" } as const;
	s.setUserPromptAt(Number.MAX_SAFE_INTEGER);
	await assert.rejects(s.handle(relay), /subsequent user prompt/);
	await s.handle({ ...escalate, questionId: "q2" });
	const escalation = (await s.store.readRegistry(s.cwd)).sessions.w1?.escalation;
	assert.equal(escalation?.questionId, "q2");
	s.setUserPromptAt(escalation!.at);
	await assert.rejects(s.handle(relay), /subsequent user prompt/);
	assert.deepEqual(s.answers, []);
	s.setUserPromptAt(escalation!.at + 1);
	assert.deepEqual(await s.handle(relay), { answered: true, questionId: "q2" });
});

test("supervisor send enforces maxConcurrent only when it would start a new turn", async (t) => {
	const s = await setup(t, { mandate: { maxConcurrent: 1 }, sessions: { w1: managed(), busy: managed(), manual: managed({ mode: "manual" }) } });
	s.live.set("busy", liveSession(true));
	s.live.set("manual", liveSession(true));
	const registry = await s.store.readRegistry(s.cwd);
	assert.equal(runningManagedSessions(registry, (id) => s.live.get(id)), 1, "manual sessions do not count");
	await assert.rejects(s.handle(send()), /Concurrency limit reached \(1/);
	// Steering a running session starts no new turn.
	assert.equal((await s.handle({ op: "send", sessionId: "busy", text: "steer", kind: "note" }) as { disposition: string }).disposition, "steering");
	s.live.set("busy", liveSession(false));
	assert.equal((await s.handle(send()) as { sent: boolean }).sent, true);
});

test("supervisor cancel is a no-op without a turn and journals a real cancel", async (t) => {
	const s = await setup(t);
	assert.deepEqual(await s.handle({ op: "cancel", sessionId: "w1" }), { cancelled: false, reason: "no turn in flight" });
	s.live.set("w1", liveSession(true));
	assert.deepEqual(await s.handle({ op: "cancel", sessionId: "w1" }), { cancelled: true });
	assert.deepEqual(s.cancelled, ["w1"]);
	assert.deepEqual(await s.ledger(), ["cancelled"]);
});

test("completion guards name every failing condition", () => {
	assert.deepEqual(completionGuardFailures(goodDigest("w"), undefined), []);
	assert.deepEqual(completionGuardFailures(goodDigest("w"), "end_turn"), []);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { run: "running" }), undefined), ["a turn is still in flight"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w"), "cancelled"), ["last turn stop reason is cancelled, not end_turn"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { pendingQuestion: true }), "end_turn"), ["a question is pending"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { plan: undefined }), "end_turn"), []);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { plan: undefined, planLookupFailed: true }), "end_turn"),
		["could not determine whether a plan is linked"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { plan: { path: "p.md", progress: null } }), "end_turn"), ["plan p.md is unreadable"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { plan: { path: "p.md", progress: { completed: 0, total: 0 } } }), "end_turn"),
		["plan p.md has no checklist items"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { plan: { path: "p.md", progress: { completed: 1, total: 3 } } }), "end_turn"),
		["plan p.md has 2 unchecked item(s)"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { finalReport: undefined }), "end_turn"), ["no final assistant report"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { finalReport: { text: "All done." } }), "end_turn"),
		["final report has no verification section"]);
	assert.deepEqual(completionGuardFailures(goodDigest("w", { finalReport: { text: "Готово.\n\n**Проверка:** тесты зелёные" } }), "end_turn"), []);
});

test("supervisor close done is refused while a guard fails and leaves task and registry untouched", async (t) => {
	const s = await setup(t);
	s.digests.set("w1", goodDigest("w1", { plan: { path: "p.md", progress: { completed: 1, total: 2 } } }));
	assert.deepEqual(await s.handle({ op: "close", sessionId: "w1", outcome: "done", summary: "ok" }),
		{ closed: false, failures: ["plan p.md has 1 unchecked item(s)"] });
	assert.equal(s.taskWrites.length, 0);
	assert.ok((await s.store.readRegistry(s.cwd)).sessions.w1);
	assert.deepEqual(await s.ledger(), ["close_refused"]);
});

test("supervisor close writes the task, unregisters the session and journals evidence", async (t) => {
	const s = await setup(t, { sessions: { w1: managed(), w2: managed({ item: { kind: "task", taskId: "task-2" } }) } });
	s.stops.set("w1", "end_turn");
	assert.deepEqual(await s.handle({ op: "close", sessionId: "w1", outcome: "done", summary: "shipped" }),
		{ closed: true, outcome: "done", taskId: "task-1", taskUpdated: true });
	// `failed` skips the completion guards.
	s.digests.set("w2", goodDigest("w2", { run: "idle", finalReport: undefined, plan: undefined }));
	assert.equal((await s.handle({ op: "close", sessionId: "w2", outcome: "failed", summary: "gave up" }) as { closed: boolean }).closed, true);
	assert.deepEqual(s.taskWrites, [{ taskId: "task-1", status: "done" }, { taskId: "task-2", status: "failed" }]);
	assert.deepEqual(s.released, ["w1", "w2"]);
	assert.deepEqual((await s.store.readRegistry(s.cwd)).sessions, {});
	const closed = (await s.store.readLedger(s.cwd)).find((entry) => entry.sessionId === "w1");
	assert.equal(closed?.kind, "closed");
	assert.equal((closed?.detail as { evidence: { stopReason: string } }).evidence.stopReason, "end_turn");
});

test("supervisor closes a completed prompt session without inventing a task or plan", async (t) => {
	const s = await setup(t, { sessions: { w1: managed({ item: { kind: "prompt" } }) } });
	s.digests.set("w1", goodDigest("w1", { task: undefined, plan: undefined, pendingQuestion: true }));
	const close = { op: "close", sessionId: "w1", outcome: "done", summary: "verified" } as const;
	assert.deepEqual(await s.handle(close), { closed: false, failures: ["a question is pending"] });
	assert.ok((await s.store.readRegistry(s.cwd)).sessions.w1);
	s.digests.set("w1", goodDigest("w1", { task: undefined, plan: undefined }));
	assert.deepEqual(await s.handle(close), { closed: true, outcome: "done" });
	assert.deepEqual(s.taskWrites, []);
	assert.deepEqual(s.released, ["w1"]);
	assert.deepEqual((await s.store.readRegistry(s.cwd)).sessions, {});
	const closed = (await s.store.readLedger(s.cwd)).at(-1);
	assert.equal(closed?.kind, "closed");
	assert.equal((closed?.detail as { evidence: { plan: unknown } }).evidence.plan, null);
});

test("close done auto-closes only supervisor-started workers; reopen restores the origin", async (t) => {
	const s = await setup(t, { sessions: {
		w1: managed({ origin: "started" }),
		w2: managed({ item: { kind: "prompt" }, origin: "handed_over" }),
		w3: managed({ item: { kind: "prompt" } }),
	} });
	for (const id of ["w1", "w2", "w3"]) {
		s.live.set(id, liveSession());
		s.digests.set(id, goodDigest(id, { task: undefined, plan: undefined }));
	}
	// A refused close never reaches the tab.
	s.stops.set("w1", "cancelled");
	assert.equal((await s.handle({ op: "close", sessionId: "w1", outcome: "done", summary: "x" }) as { closed: boolean }).closed, false);
	assert.deepEqual(s.autoClosed, []);
	s.stops.set("w1", "end_turn");
	for (const [id, outcome] of [["w1", "done"], ["w2", "done"], ["w3", "failed"]] as const) {
		assert.equal((await s.handle({ op: "close", sessionId: id, outcome, summary: "x" }) as { closed: boolean }).closed, true);
	}
	assert.deepEqual(s.autoClosed, ["w1"], "only started origin, only done");
	assert.equal(s.catalogRefreshes(), 3, "every successful close refreshes the Desktop catalog; a refused one does not");
	const closed = (await s.store.readLedger(s.cwd)).filter((entry) => entry.kind === "closed" && entry.sessionId === "w1").at(-1);
	assert.equal((closed?.detail as { origin?: string }).origin, "started");
	assert.equal((await s.handle({ op: "reopen", sessionId: "w1" }) as { reopened: boolean }).reopened, true);
	assert.equal((await s.store.readRegistry(s.cwd)).sessions.w1?.origin, "started");
	assert.equal(s.catalogRefreshes(), 4, "reopen refreshes the catalog too");
});

test("a user takeover holding the lock wins over a racing supervisor send", async (t) => {
	const s = await setup(t);
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	// The takeover takes the project lock first, like ACP's prompt() path.
	const takeover = s.exclusive(s.cwd, async () => {
		await gate;
		await s.store.updateRegistry(s.cwd, (current) => ({
			...current, sessions: { ...current.sessions, w1: { ...current.sessions.w1!, mode: "manual" } },
		}));
	});
	const racing = s.handle(send("late"));
	release();
	await takeover;
	await assert.rejects(racing, /taken over by the user/);
	assert.equal(s.delivered.length, 0, "the racing send is rejected, not queued");
});

test("supervisor reopen restores a closed item with its rework count and task status", async (t) => {
	const s = await setup(t, { sessions: { w1: managed({ reworkRounds: 2, briefed: true }) } });
	await assert.rejects(s.handle({ op: "reopen", sessionId: "w1" }), /already registered/);
	await assert.rejects(s.handle({ op: "reopen", sessionId: "never" }), /no supervisor closure/);
	await s.handle({ op: "close", sessionId: "w1", outcome: "failed", summary: "wrong call" });
	assert.deepEqual(await s.handle({ op: "reopen", sessionId: "w1" }), {
		reopened: true, reworkRounds: 2, taskId: "task-1", taskUpdated: true,
		note: "The session is managed again; send rework to start a new turn.",
	});
	const entry = (await s.store.readRegistry(s.cwd)).sessions.w1;
	assert.deepEqual([entry?.item, entry?.mode, entry?.reworkRounds, entry?.briefed], [{ kind: "task", taskId: "task-1" }, "managed", 2, true]);
	assert.deepEqual(s.taskWrites.at(-1), { taskId: "task-1", status: "in-progress" });
	// A reopened item is registered again, so a second reopen is refused.
	await assert.rejects(s.handle({ op: "reopen", sessionId: "w1" }), /already registered/);
	assert.deepEqual(await s.ledger(), ["closed", "reopened"]);
});

test("supervisor reopen refuses a deleted session and a paused mandate", async (t) => {
	const s = await setup(t);
	await s.handle({ op: "close", sessionId: "w1", outcome: "failed", summary: "x" });
	s.gone.add("w1");
	await assert.rejects(s.handle({ op: "reopen", sessionId: "w1" }), /no longer exists/);
	await s.store.updateMandate(s.cwd, { paused: true });
	s.gone.delete("w1");
	await assert.rejects(s.handle({ op: "reopen", sessionId: "w1" }), /paused/);
	assert.deepEqual((await s.store.readRegistry(s.cwd)).sessions, {});
});

test("supervisor start launches an item, registers it managed and briefed, and journals it", async (t) => {
	const s = await setup(t, { sessions: {}, standardWorkerModel: async () => "p/worker:low" });
	assert.deepEqual(await s.handle({ op: "start", item: { kind: "task", taskId: "t9" } }), {
		started: true, sessionId: "new1", item: { kind: "task", taskId: "t9" },
		note: "The session is running with the worker rules; you get a digest when it settles.",
	});
	await s.handle({ op: "start", item: { kind: "plan", path: ".pi/plans/p.md" } });
	await s.handle({ op: "start", item: { kind: "prompt", text: "fix the flaky test" }, modelRef: "p/explicit" });
	assert.deepEqual(s.launches.map(({ modelRef, caller }) => [modelRef, caller]),
		[["p/worker:low", SUPERVISOR], ["p/worker:low", SUPERVISOR], ["p/explicit", SUPERVISOR]]);
	const sessions = (await s.store.readRegistry(s.cwd)).sessions;
	assert.deepEqual(sessions.new3?.item, { kind: "prompt" });
	for (const id of ["new1", "new2", "new3"]) assert.deepEqual([sessions[id]?.mode, sessions[id]?.briefed, sessions[id]?.reworkRounds, sessions[id]?.origin], ["managed", true, 0, "started"]);
	assert.deepEqual(await s.ledger(), ["started", "started", "started"]);
	const ledger = await s.store.readLedger(s.cwd);
	assert.equal((ledger.at(-1)?.detail as { text?: string }).text, "fix the flaky test");
});

test("supervisor start refuses duplicates, a paused mandate and a full concurrency budget", async (t) => {
	const s = await setup(t, { mandate: { maxConcurrent: 1 } });
	await assert.rejects(s.handle({ op: "start", item: { kind: "task", taskId: "task-1" } }), /Already registered as session w1/);
	s.live.set("w1", liveSession(true));
	await assert.rejects(s.handle({ op: "start", item: { kind: "prompt", text: "x" } }), /Concurrency limit reached \(1/);
	s.live.set("w1", liveSession(false));
	await s.store.updateMandate(s.cwd, { paused: true });
	await assert.rejects(s.handle({ op: "start", item: { kind: "prompt", text: "x" } }), /paused/);
	assert.equal(s.launches.length, 0);
	await s.store.updateMandate(s.cwd, { paused: false });
	s.failLaunch(new Error("Desktop is busy"));
	await assert.rejects(s.handle({ op: "start", item: { kind: "prompt", text: "x" } }), /Desktop is busy/);
	assert.deepEqual(Object.keys((await s.store.readRegistry(s.cwd)).sessions), ["w1"], "a failed launch registers nothing");
	assert.deepEqual(await s.ledger(), []);
});

test("supervisor does not launch if its runtime retires while reading the fallback model", async (t) => {
	const reading = Promise.withResolvers<void>();
	const model = Promise.withResolvers<string>();
	const s = await setup(t, { standardWorkerModel: () => { reading.resolve(); return model.promise; } });
	let current = true;
	const started = s.handle({ op: "start", item: { kind: "prompt", text: "x" } }, SUPERVISOR, () => current);
	await reading.promise;
	current = false;
	model.resolve("p/worker");
	await assert.rejects(started, /no longer the project supervisor/);
	assert.deepEqual(s.launches, []);
});

test("concurrent supervisor starts cannot both pass maxConcurrent", async (t) => {
	const s = await setup(t, { sessions: {}, mandate: { maxConcurrent: 1 } });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	s.gate(() => { entered.resolve(); return release.promise; });
	const first = s.handle({ op: "start", item: { kind: "prompt", text: "a" } });
	let secondRejected: Promise<void>;
	try {
		const launchEntered = await Promise.race([entered.promise.then(() => true), first.then(() => false)]);
		assert.ok(launchEntered, "the first start must enter launch before completing");
		secondRejected = assert.rejects(s.handle({ op: "start", item: { kind: "prompt", text: "b" } }), /Concurrency limit reached/);
	} finally {
		release.resolve();
	}
	await Promise.all([first, secondRejected]);
	assert.equal(s.launches.length, 1);
});
