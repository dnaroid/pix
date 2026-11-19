import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupervisorWaker } from "../src/acp/supervisor-wake.js";
import { createSessionEventMonitor, type SessionEvent, type SessionEventObserver } from "../src/acp/session-events.js";
import type { ManagedSession } from "../src/acp/supervisor-store.js";

function harness(options: { paused?: boolean; supervisor?: string | undefined } = {}) {
	const timers = new Set<() => void>();
	const queue: { id: string; text: string }[] = [];
	let paused = options.paused ?? false;
	const supervisorSessionId = "supervisor" in options ? options.supervisor : "sup";
	const sessions: Record<string, ManagedSession> = Object.fromEntries(["w1", "w2", "w3"].map((id) => [id,
		{ item: { kind: "prompt" }, mode: "managed", registeredAt: 0, reworkRounds: 0 },
	]));
	let next = 0;
	const waker = createSupervisorWaker({
		debounceMs: 10,
		setTimer: (callback) => { timers.add(callback); return callback; },
		clearTimer: (handle) => { timers.delete(handle as () => void); },
		registryFor: async () => ({ version: 1, ...(supervisorSessionId ? { supervisorSessionId } : {}), sessions: { ...sessions } }),
		paused: async () => paused,
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
	return { waker, queue, timers, fire, sessions, setPaused: (value: boolean) => { paused = value; } };
}

const settled = (sessionId: string): SessionEvent => ({ type: "settled", sessionId, at: 1, stopReason: "end_turn", touchedFiles: ["a.ts"] });
const stalled = (sessionId: string): SessionEvent => ({ type: "stalled", sessionId, at: 2, idleMs: 900_000 });
const fileChanged = (sessionId: string, path = "src/a.ts"): SessionEvent => ({ type: "file_changed", sessionId, at: 3, path });

function edit(observer: SessionEventObserver, path: string) {
	observer.event({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path } });
	observer.event({ type: "tool_execution_end", toolCallId: "edit", isError: false });
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
