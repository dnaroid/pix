import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupervisorWaker } from "../src/acp/supervisor-wake.js";
import type { SessionEvent } from "../src/acp/session-events.js";
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
		registryFor: async () => ({ version: 1, ...(supervisorSessionId ? { supervisorSessionId } : {}), sessions }),
		paused: async () => paused,
		enqueue: async (_sup, text, replace) => {
			const existing = queue.find((item) => item.id === replace?.id);
			if (existing && replace) { existing.text = replace.text; return { itemId: existing.id, replaced: true }; }
			const itemId = `q${next++}`;
			queue.push({ id: itemId, text });
			return { itemId, replaced: false };
		},
	});
	const fire = async () => {
		const pending = [...timers];
		timers.clear();
		for (const callback of pending) callback();
		await waker.whenIdle();
	};
	return { waker, queue, timers, fire, sessions, setPaused: (value: boolean) => { paused = value; } };
}

const settled = (sessionId: string): SessionEvent => ({ type: "settled", sessionId, at: 1, stopReason: "end_turn", touchedFiles: ["a.ts"] });
const stalled = (sessionId: string): SessionEvent => ({ type: "stalled", sessionId, at: 2, idleMs: 900_000 });

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
