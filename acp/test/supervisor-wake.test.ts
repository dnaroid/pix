import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSupervisorBudget, createSupervisorBudgetUsage, SUPERVISOR_BUDGET_WINDOW_MS as WINDOW } from "../src/acp/supervisor-budget.js";
import { createSupervisorWaker } from "../src/acp/supervisor-wake.js";
import { createSessionEventMonitor, type SessionEvent, type SessionEventObserver } from "../src/acp/session-events.js";
import { DEFAULT_MANDATE, type ManagedSession, type SupervisorMandate } from "../src/acp/supervisor-store.js";

function harness(options: { paused?: boolean; supervisor?: string | undefined; budgetTokens?: number } = {}) {
	const timers = new Set<() => void>();
	const queue: { id: string; text: string }[] = [];
	let mandate: SupervisorMandate = { ...DEFAULT_MANDATE, ...(options.budgetTokens === undefined ? {} : { budgetTokens: options.budgetTokens }), paused: options.paused ?? false };
	const supervisorSessionId = "supervisor" in options ? options.supervisor : "sup";
	const sessions: Record<string, ManagedSession> = Object.fromEntries(["w1", "w2", "w3"].map((id) => [id,
		{ item: { kind: "prompt" }, mode: "managed", registeredAt: 0, reworkRounds: 0 },
	]));
	let next = 0;
	let now = WINDOW + 100;
	let queries = 0;
	const spend: { at: number; tokens: number; id: string }[] = [];
	const stops: { used: number | null; limit: number }[] = [];
	const registry = () => ({ version: 1 as const, ...(supervisorSessionId ? { supervisorSessionId } : {}), sessions: { ...sessions } });
	const budget = createSupervisorBudget({
		now: () => now,
		usage: async (_cwd, ids, at) => {
			queries += 1;
			return spend.filter((point) => ids.has(point.id) && point.at >= at - WINDOW && point.at <= at)
				.reduce((sum, point) => sum + point.tokens, 0);
		},
		escalate: async (_cwd, detail) => { stops.push(detail); },
	});
	const waker = createSupervisorWaker({
		debounceMs: 10,
		setTimer: (callback) => { timers.add(callback); return callback; },
		clearTimer: (handle) => { timers.delete(handle as () => void); },
		registryFor: async () => registry(),
		paused: async () => mandate.paused,
		budgetBlocks: (cwd, registry) => budget.blocks(cwd, mandate, registry),
		enqueue: async (_sup, text, replace) => {
			const existing = queue.find((item) => item.id === replace?.id);
			if (existing && replace) { existing.text = replace.text; return { itemId: existing.id, replaced: true }; }
			const itemId = `q${next++}`;
			queue.push({ id: itemId, text });
			return { itemId, replaced: false };
		},
		rewrite: async (_sup, itemId, text) => {
			const index = queue.findIndex((item) => item.id === itemId);
			if (index < 0) return false;
			if (text === undefined) queue.splice(index, 1);
			else queue[index]!.text = text;
			return true;
		},
	});
	const fire = async () => {
		await waker.whenIdle(); // edits resolve registry snapshots before scheduling a wake
		const pending = [...timers];
		timers.clear();
		for (const callback of pending) callback();
		await waker.whenIdle();
	};
	return {
		waker, queue, timers, fire, sessions, stops, budget,
		get queries() { return queries; },
		setPaused: (paused: boolean) => { mandate = { ...mandate, paused }; },
		status: () => budget.status("/p", mandate, registry()),
		advance: (ms: number) => { now += ms; },
		spend: (id: string, tokens: number) => { spend.push({ id, at: now, tokens }); },
		async change(patch: { budgetTokens?: number | null; paused?: boolean }) {
			await waker.updateAndRecheck("/p", async () => {
				const previous = mandate;
				const { budgetTokens, ...rest } = patch;
				mandate = { ...mandate, ...rest, ...(budgetTokens == null ? {} : { budgetTokens }) };
				if (budgetTokens === null) delete (mandate as { budgetTokens?: number }).budgetTokens;
				return budget.mandateChanged("/p", previous, mandate, registry(), patch.paused === false);
			});
		},
	};
}

const settled = (sessionId: string): SessionEvent => ({ type: "settled", sessionId, at: 1, stopReason: "end_turn", touchedFiles: ["a.ts"] });
const stalled = (sessionId: string): SessionEvent => ({ type: "stalled", sessionId, at: 2, idleMs: 900_000 });
const fileChanged = (sessionId: string, path = "src/a.ts"): SessionEvent => ({ type: "file_changed", sessionId, at: 3, path });

function edit(observer: SessionEventObserver, path: string) {
	observer.event({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path } });
	observer.event({ type: "tool_execution_end", toolCallId: "edit", isError: false });
}

function patch(observer: SessionEventObserver, input: string) {
	observer.event({ type: "tool_execution_start", toolCallId: "patch", toolName: "apply_patch", args: { input } });
	observer.event({ type: "tool_execution_end", toolCallId: "patch", isError: false });
}

test("several worker events produce one wake digest", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	h.waker.push("/p", stalled("w2"));
	h.waker.push("/p", settled("w2"));
	assert.equal(h.timers.size, 1);
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1: turn settled/);
	assert.match(h.queue[0]!.text, /w2: stalled for 15 min; turn settled/);
});

test("a still-queued digest is rewritten, not multiplied; consumed one is followed by a new one", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	await h.fire();
	h.waker.push("/p", stalled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1:.*\n- w2: stalled/);
	h.queue.length = 0; // supervisor consumed it
	h.waker.push("/p", settled("w3"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /w1/);
});

test("supervisor's own events and missing supervisor never wake", async () => {
	const h = harness();
	h.waker.push("/p", settled("sup"));
	await h.fire();
	assert.equal(h.queue.length, 0);
	const none = harness({ supervisor: undefined });
	none.waker.push("/p", settled("w1"));
	await none.fire();
	assert.equal(none.queue.length, 0);
});

test("unregistered and manual lifecycle events do not wake or crowd out managed events", async () => {
	const h = harness();
	h.sessions.w1 = { ...h.sessions.w1!, mode: "manual" };
	h.waker.push("/p", settled("w1"));
	h.waker.push("/p", settled("unregistered"));
	await h.fire();
	assert.equal(h.queue.length, 0);
	for (let i = 0; i < 25; i++) h.waker.push("/p", settled(`unregistered-${i}`));
	h.waker.push("/p", settled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w2: turn settled/);
	assert.doesNotMatch(h.queue[0]!.text, /unregistered|w1:/);
});

test("manual takeover remains in the digest, but prior queued lifecycle events are removed on rewrite", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	await h.fire();
	h.sessions.w1 = { ...h.sessions.w1!, mode: "manual" };
	h.waker.push("/p", { type: "manual_takeover", sessionId: "w1", at: 2 });
	h.waker.push("/p", stalled("w1"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1: taken over by the user/);
	assert.doesNotMatch(h.queue[0]!.text, /settled|stalled/);
});

test("pause holds the wake but keeps the digest", async () => {
	const h = harness({ paused: true });
	h.waker.push("/p", settled("w1"));
	await h.fire();
	assert.equal(h.queue.length, 0);
	h.setPaused(false);
	h.waker.push("/p", stalled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1:[\s\S]*w2:/);
});

test("without a token budget a wake never queries usage", async () => {
	const h = harness();
	h.spend("sup", 999);
	h.waker.push("/p", settled("w1"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.equal(h.queries, 0);
	assert.deepEqual(await h.status(), {});
});

test("only the supervisor and currently managed sessions contribute to the budget", async () => {
	const h = harness({ budgetTokens: 10 });
	h.spend("sup", 3);
	h.spend("w1", 6);
	h.spend("w2", 100);
	h.spend("w3", 100);
	h.sessions.w2 = { ...h.sessions.w2!, mode: "manual" };
	delete h.sessions.w3;
	h.waker.push("/p", settled("w1"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.deepEqual(await h.status(), { budgetTokens: 10, budgetUsedTokens: 9 });
});

test("at the limit holds and coalesces at/over-budget events; expiry requires an explicit resume", async () => {
	const h = harness({ budgetTokens: 10 });
	h.spend("sup", 10);
	h.waker.push("/p", settled("w1"));
	await h.fire();
	h.spend("w2", 5);
	h.waker.push("/p", stalled("w2"));
	await h.fire();
	await h.change({ paused: false }); // still over
	assert.deepEqual(h.stops, [{ used: 10, limit: 10 }]);
	assert.equal(h.queue.length, 0);
	h.advance(WINDOW + 1);
	h.waker.push("/p", settled("w3"));
	await h.fire();
	assert.deepEqual(await h.status(), { budgetTokens: 10, budgetUsedTokens: 0, budgetHeld: true });
	assert.equal(h.timers.size, 0);
	assert.equal(h.queue.length, 0);
	await h.change({ paused: false });
	await h.change({ paused: false });
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1:[\s\S]*w2:[\s\S]*w3:/);
	assert.equal(h.stops.length, 1);
});

test("unrelated mandate edits and an insufficient raise do not release a hold; a raise or clear does", async () => {
	for (const budgetTokens of [12, null]) {
		const h = harness({ budgetTokens: 5 });
		h.spend("w1", 11);
		h.waker.push("/p", settled("w1"));
		await h.fire();
		await h.change({});
		await h.change({ budgetTokens: 11 });
		assert.deepEqual(h.stops, [{ used: 11, limit: 5 }]);
		assert.equal(h.queue.length, 0);
		await h.change({ budgetTokens });
		assert.equal(h.queue.length, 1);
		assert.equal((await h.status()).budgetHeld, undefined);
	}
});

test("pause takes precedence, and clearing the budget does not bypass pause", async () => {
	const h = harness({ paused: true, budgetTokens: 1 });
	h.spend("sup", 1);
	h.waker.push("/p", settled("w1"));
	await h.fire();
	assert.equal(h.queries, 0);
	await h.change({ paused: false });
	assert.equal(h.stops.length, 1);
	await h.change({ paused: true });
	await h.change({ budgetTokens: null });
	assert.equal(h.queue.length, 0);
	await h.change({ paused: false });
	assert.equal(h.queue.length, 1);
});

test("dispose while held clears the debounce and prevents retry", async () => {
	const h = harness({ budgetTokens: 1 });
	h.spend("sup", 1);
	h.waker.push("/p", settled("w1"));
	await h.fire();
	h.waker.push("/p", settled("w2"));
	assert.equal(h.timers.size, 1);
	h.waker.dispose();
	h.budget.dispose();
	assert.equal(h.timers.size, 0);
	await h.change({ budgetTokens: null });
	assert.equal(h.queue.length, 0);
	assert.equal(h.stops.length, 1);
});

test("a saved hold survives adapter recreation and window expiry until Resume", async () => {
	let saved: string | undefined;
	let used = 10;
	let stopCount = 0;
	const deps = {
		usage: async () => used,
		readHold: async () => saved,
		writeHold: async (_cwd: string, id: string | undefined) => { saved = id; },
		escalate: async () => { stopCount++; },
	};
	const mandate = { ...DEFAULT_MANDATE, budgetTokens: 10 };
	const registry = { version: 1 as const, supervisorSessionId: "sup", sessions: {} };
	const first = createSupervisorBudget(deps);
	assert.equal(await first.blocks("/p", mandate, registry), true);
	first.dispose();
	used = 0;
	const next = createSupervisorBudget(deps);
	assert.equal(await next.blocks("/p", mandate, registry), true);
	assert.equal(stopCount, 1);
	assert.equal((await next.mandateChanged("/p", mandate, mandate, registry, true)).retry, true);
	assert.equal(await next.blocks("/p", mandate, registry), false);
});

test("JSONL usage tails handle expiry, append, forks, replacement and missing files", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-supervisor-budget-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sup = join(dir, "sup.jsonl"), fork = join(dir, "fork.jsonl");
	const at = WINDOW + 1000;
	const entry = (id: string, timestamp: number, totalTokens: number) => JSON.stringify({ type: "message", id,
		message: { role: "assistant", timestamp, usage: { totalTokens, input: 1, output: 1 } } });
	const copied = entry("copied", at - WINDOW, 10);
	await writeFile(sup, `${entry("expired", at - WINDOW - 1, 100)}\n${copied}\n${entry("fresh", at, 7)}`);
	const usage = createSupervisorBudgetUsage(async (_cwd, ids) => [...ids].map(([id, until]) => [id === "fork" ? fork : sup, until] as const));
	t.after(usage.dispose);
	const ids = new Map([["sup", at], ["fork", at]]);
	assert.equal(await usage.usage(dir, ids, at), 10, "unfinished line and uncreated file are ignored");
	await appendFile(sup, "\n");
	await writeFile(fork, `${copied}\n${entry("fork", at, 9)}\n`);
	assert.equal(await usage.usage(dir, ids, at), 26, "totalTokens, including cache; copied ancestor counted once");
	assert.equal(await usage.usage(dir, ids, at + 1), 16, "expiry without file changes");
	assert.equal(await usage.usage(dir, new Map([["sup", at]]), at + 1), 7, "removed member excluded");
	assert.equal(await usage.usage(dir, new Map([["sup", at - 1]]), at + 1), 0, "post-rotation usage excluded");
	const replacement = join(dir, "replacement.jsonl");
	await writeFile(replacement, `${entry("new", at, 3)}\n`);
	await rename(replacement, sup);
	assert.equal(await usage.usage(dir, ids, at + 1), 12);
});

test("dispose releases pending timers and ignores later events", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	assert.equal(h.timers.size, 1);
	h.waker.dispose();
	assert.equal(h.timers.size, 0);
	h.waker.push("/p", settled("w2"));
	assert.equal(h.timers.size, 0);
});

test("successful normalized edits notify before settlement and deduplicate across runtime replacement", async (t) => {
	const h = harness();
	const monitor = createSessionEventMonitor();
	t.after(() => { monitor.dispose(); h.waker.dispose(); });
	monitor.subscribe((event) => h.waker.push("/p", event));
	const w1 = monitor.observe("w1", "/p");
	const w2 = monitor.observe("w2", "/p");
	edit(w1, "src/a.ts");
	edit(w1, "src/./a.ts");
	edit(w2, "src/distinct.ts");
	await h.fire();
	assert.equal(h.queue.length, 0, "no self-conflict or wake on a non-overlap");
	edit(w2, "/p/src/../src/a.ts");
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w2: file conflict with w1: src\/a\.ts/);
	h.queue.length = 0;
	edit(monitor.observe("w2", "/p"), "src/a.ts");
	edit(w1, "src/a.ts");
	await h.fire();
	assert.equal(h.queue.length, 0, "neither edit order nor runtime replacement repeats the same conflict");
});

test("conflicts require two managed workers in one project when they edit", async () => {
	const h = harness();
	const w2 = h.sessions.w2!;
	h.sessions.sup = w2; // even a registry entry cannot make the supervisor its own worker
	h.sessions.w2 = { ...w2, mode: "manual" };
	h.waker.push("/p", fileChanged("sup"));
	h.waker.push("/p", fileChanged("not-managed"));
	h.waker.push("/p", fileChanged("w2"));
	h.sessions["not-managed"] = w2;
	h.sessions.w2 = w2; // later ownership changes must not make earlier edits eligible
	h.waker.push("/another-project", fileChanged("w3"));
	h.waker.push("/p", fileChanged("w1"));
	await h.fire();
	assert.equal(h.queue.length, 0);
	h.waker.push("/p/.", fileChanged("w2"));
	await h.fire();
	assert.match(h.queue[0]!.text, /w2: file conflict with w1: src\/a\.ts/);
});

test("different overlapping files and peers coalesce into one digest, even while paused", async () => {
	const h = harness({ paused: true });
	h.waker.push("/p", fileChanged("w1"));
	h.waker.push("/p", fileChanged("w3", "src/b.ts"));
	h.waker.push("/p", fileChanged("w2"));
	h.waker.push("/p", fileChanged("w2", "src/b.ts"));
	await h.fire();
	assert.equal(h.queue.length, 0);
	h.setPaused(false);
	h.waker.push("/p", settled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /file conflict with w1: src\/a\.ts; file conflict with w3: src\/b\.ts/);
	h.waker.push("/p", fileChanged("w3"));
	await h.fire();
	assert.equal(h.queue.length, 1, "rewrites the still-queued digest");
	assert.match(h.queue[0]!.text, /w3: file conflict with w1: src\/a\.ts; file conflict with w2: src\/a\.ts/);
});

test("conflicts lose eligibility if either worker leaves, and re-registration requires a fresh edit", async () => {
	const h = harness();
	const w1 = h.sessions.w1!;
	h.waker.push("/p", fileChanged("w1"));
	h.waker.push("/p", fileChanged("w2"));
	await h.fire();
	assert.match(h.queue[0]!.text, /file conflict/);
	delete h.sessions.w1;
	h.sessions.w1 = { ...w1, registeredAt: w1.registeredAt + 1 };
	h.waker.push("/p", stalled("w3"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /file conflict/, "a queued digest drops conflicts from the prior registration");
	h.waker.push("/p", fileChanged("w1"));
	await h.fire();
	assert.match(h.queue[0]!.text, /w1: file conflict with w2/);
	h.sessions.w2 = { ...h.sessions.w2!, mode: "manual" };
	h.waker.push("/p", { type: "manual_takeover", sessionId: "w2", at: 4 });
	await h.fire();
	assert.doesNotMatch(h.queue[0]!.text, /file conflict/, "filter the peer, not just the line's worker");
});

test("manual takeover before delivery invalidates conflicts even if the worker is quickly handed back", async () => {
	const h = harness();
	const w1 = h.sessions.w1!;
	h.waker.push("/p", fileChanged("w1"));
	h.waker.push("/p", fileChanged("w2"));
	h.sessions.w1 = { ...w1, mode: "manual" };
	h.waker.push("/p", { type: "manual_takeover", sessionId: "w1", at: 4 });
	h.waker.push("/p", fileChanged("w1"));
	h.sessions.w1 = w1;
	await h.fire();
	assert.doesNotMatch(h.queue[0]!.text, /file conflict/);
	h.waker.push("/p", fileChanged("w1"));
	await h.fire();
	assert.match(h.queue[0]!.text, /- w1:[^\n]*file conflict with w2/);
});

test("removing a peer before debounce suppresses a conflict-only wake", async () => {
	const h = harness();
	h.waker.push("/p", fileChanged("w1"));
	h.waker.push("/p", fileChanged("w2"));
	await h.waker.whenIdle();
	assert.equal(h.timers.size, 1);
	delete h.sessions.w1;
	await h.fire();
	assert.equal(h.queue.length, 0);
});

test("dispose invalidates an overlap still waiting on its registry snapshots", async () => {
	const h = harness();
	h.waker.push("/p", fileChanged("w1"));
	h.waker.push("/p", fileChanged("w2"));
	const idle = h.waker.whenIdle();
	await Promise.resolve(); // enter the first snapshot await
	h.waker.dispose();
	await idle;
	assert.equal(h.timers.size, 0);
	assert.equal(h.queue.length, 0);
});

test("forget withdraws a session's lines from a still-queued digest and drops an emptied one", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	h.waker.push("/p", settled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	delete h.sessions.w1;
	h.waker.forget("/p", "w1");
	await h.waker.whenIdle();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /w1:/);
	assert.match(h.queue[0]!.text, /w2: turn settled/);
	delete h.sessions.w2;
	h.waker.forget("/p", "w2");
	await h.waker.whenIdle();
	assert.equal(h.queue.length, 0, "a digest with no remaining sessions is removed, not left empty");
	// A later event starts a fresh digest instead of rewriting the removed item.
	h.waker.push("/p", settled("w3"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /w1|w2/);
});

test("forget drops pending events before the debounce fires", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	delete h.sessions.w1;
	h.waker.forget("/p", "w1");
	await h.fire();
	assert.equal(h.queue.length, 0);
});

test("forget after the supervisor consumed the digest changes nothing and the next digest is fresh", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	h.waker.push("/p", settled("w2"));
	await h.fire();
	h.queue.length = 0; // supervisor consumed it
	delete h.sessions.w1;
	h.waker.forget("/p", "w1");
	await h.waker.whenIdle();
	assert.equal(h.queue.length, 0, "a consumed digest is never re-queued");
	h.waker.push("/p", stalled("w2"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /w1/);
});

test("forget is ordered after an in-flight flush, so the withdrawn session never survives a rewrite", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	await h.fire();
	h.waker.push("/p", stalled("w2"));
	const pending = [...h.timers];
	h.timers.clear();
	for (const callback of pending) callback(); // flush queued on the chain, not yet run
	delete h.sessions.w1;
	h.waker.forget("/p", "w1");
	await h.waker.whenIdle();
	assert.equal(h.queue.length, 1);
	assert.doesNotMatch(h.queue[0]!.text, /w1:/);
	assert.match(h.queue[0]!.text, /w2: stalled/);
});

test("a session handed over again before the withdrawal runs keeps its new events", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	await h.fire();
	const entry = h.sessions.w1!;
	delete h.sessions.w1;
	h.waker.forget("/p", "w1"); // queued on the chain
	h.sessions.w1 = { ...entry, registeredAt: 5 }; // handed over again before it runs
	h.waker.push("/p", stalled("w1"));
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w1: .*stalled/);
});

test("forget of a still-registered session changes nothing", async () => {
	const h = harness();
	h.waker.push("/p", settled("w1"));
	await h.fire();
	const before = h.queue[0]!.text;
	h.waker.forget("/p", "w1");
	await h.waker.whenIdle();
	assert.deepEqual(h.queue.map((item) => item.text), [before]);
});

test("apply_patch edits and moves conflict with another managed worker's edit", async (t) => {
	const h = harness();
	const monitor = createSessionEventMonitor();
	t.after(() => { monitor.dispose(); h.waker.dispose(); });
	monitor.subscribe((event) => h.waker.push("/p", event));
	const w1 = monitor.observe("w1", "/p");
	const w2 = monitor.observe("w2", "/p");
	const w3 = monitor.observe("w3", "/p");
	edit(w1, "src/a.ts");
	patch(w2, "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch");
	patch(w3, "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/a.ts\n*** End Patch");
	await h.fire();
	assert.equal(h.queue.length, 1);
	assert.match(h.queue[0]!.text, /w2: file conflict with w1: src\/a\.ts/);
	assert.match(h.queue[0]!.text, /w3: file conflict with w1: src\/a\.ts; file conflict with w2: src\/a\.ts/);
});
