import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { TuiMemoryTrace, TUI_MEMORY_TRACE_MAX_PROFILE_BYTES } from "../src/app/diagnostics/tui-memory-trace.js";

function harness(enabled = true) {
	const messages: any[] = [];
	const writes: { path: string; contents: string }[] = [];
	const writeSignals: AbortSignal[] = [];
	const child = new EventEmitter() as ChildProcess;
	let tick: (() => void) | undefined;
	let sendCallback: ((error: Error | null) => void) | undefined;
	let profileCallback: ((error: Error | null, result?: any) => void) | undefined;
	let pendingWrite: Promise<void> | undefined;
	let deferredSends = false;
	let disconnects = 0;
	let forks = 0;
	let unrefs = 0;
	Object.assign(child, {
		connected: true,
		channel: { unref: () => { unrefs++; } },
		unref: () => { unrefs++; },
		disconnect: () => { Object.assign(child, { connected: false }); },
		send: (message: any, callback: (error: Error | null) => void) => {
			messages.push(message);
			if (deferredSends && message.event === "heartbeat") sendCallback = callback;
			else callback(null);
			return true;
		},
	});
	const inspector = {
		connect: () => {},
		disconnect: () => { disconnects++; },
		post: (method: string, _params: unknown, callback: (error: Error | null, result?: any) => void) => {
			if (method === "HeapProfiler.startSampling") callback(null);
			else profileCallback = callback;
		},
	};
	const trace = new TuiMemoryTrace(() => ({ draftChars: 14, streaming: false, text: "DO NOT RECORD", sessionId: "private", nested: { secret: true } }), {
		enabled,
		fork: () => { forks++; return child; },
		inspector: () => inspector,
		memoryUsage: () => ({ rss: 123, heapUsed: 10, heapTotal: 20, external: 30, arrayBuffers: 40 }),
		setInterval: (callback) => { tick = callback; return { unref: () => { unrefs++; } } as ReturnType<typeof setInterval>; },
		clearInterval: () => { tick = undefined; },
		writeProfile: async (path, contents, signal) => { writes.push({ path, contents }); writeSignals.push(signal); await pendingWrite; },
	});
	return {
		trace, child, messages, writes, writeSignals,
		ready: () => child.emit("message", { event: "ready", directory: "/private/trace" }),
		tick: (n = 1) => { for (let i = 0; i < n; i++) tick?.(); },
		profile: (result: any = { profile: { head: {}, samples: [] } }) => { const cb = profileCallback; profileCallback = undefined; cb?.(null, result); },
		deferSend: () => { deferredSends = true; },
		deliverSend: () => { sendCallback?.(null); },
		deferWrite: (promise: Promise<void>) => { pendingWrite = promise; },
		stats: () => ({ forks, unrefs, disconnects, hasTick: !!tick, hasProfile: !!profileCallback }),
	};
}

test("trace is opt-in, idempotent, and all process/timer resources are unref'd", () => {
	const off = harness(false);
	off.trace.start(3072);
	assert.equal(off.stats().forks, 0);
	const h = harness();
	h.trace.start(3072);
	h.trace.start(3072);
	assert.equal(h.stats().forks, 1);
	assert.equal(h.stats().unrefs, 3);
	assert.deepEqual(h.messages[0], { event: "start", thresholdMb: 1024 });
	h.trace.stop();
	h.trace.stop();
	assert.equal(h.stats().disconnects, 1);
	assert.equal(h.stats().hasTick, false);
	assert.equal(h.child.connected, false);
	assert.equal(h.child.listenerCount("message"), 0);
	h.child.emit("exit", 0);
	assert.equal(h.child.listenerCount("error"), 0);
});

test("heartbeats exclude text/session IDs, and backpressure bounds pending IPC", () => {
	const h = harness();
	h.trace.start(64);
	h.deferSend();
	h.ready();
	h.tick(500);
	assert.equal(h.messages.length, 2);
	assert.deepEqual(h.messages[1].app, { draftChars: 14, streaming: false });
	h.deliverSend();
	h.tick();
	assert.equal(h.messages.length, 3);
	h.trace.stop();
});

test("allocation profiles rotate three Chrome-compatible files and reject oversized output", async () => {
	const h = harness();
	h.trace.start(64);
	h.ready();
	for (let i = 0; i < 4; i++) {
		h.tick(30);
		h.profile();
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.deepEqual(h.writes.map((write) => write.path), [0, 1, 2, 0].map((i) => join("/private/trace", `allocations-${i}.heapprofile`)));
	assert.deepEqual(JSON.parse(h.writes[0]!.contents), { head: {}, samples: [] });
	h.tick(30);
	h.profile({ profile: { value: "a".repeat(TUI_MEMORY_TRACE_MAX_PROFILE_BYTES) } });
	assert.equal(h.writes.length, 4);
	h.trace.stop();
});

test("a profile request or file write in flight is not duplicated", async () => {
	const h = harness();
	h.trace.start(64);
	h.ready();
	h.tick(29);
	assert.equal(h.stats().hasProfile, true);
	h.tick(90);
	let finish!: () => void;
	h.deferWrite(new Promise<void>((resolve) => { finish = resolve; }));
	h.profile();
	h.tick(90);
	assert.equal(h.stats().hasProfile, false);
	assert.equal(h.writes.length, 1);
	finish();
	await new Promise((resolve) => setImmediate(resolve));
	h.tick(30);
	assert.equal(h.stats().hasProfile, true);
	h.trace.stop();
});

test("late profiler callbacks/worker messages after stop cannot write or restart resources", () => {
	const h = harness();
	h.trace.start(64);
	h.ready();
	h.tick(29);
	h.trace.stop();
	h.profile();
	h.ready();
	h.tick(100);
	assert.equal(h.writes.length, 0);
	assert.equal(h.stats().hasTick, false);
});

test("stop aborts an in-flight profile write without waiting for filesystem completion", async () => {
	const h = harness();
	h.trace.start(64);
	h.ready();
	let finish!: () => void;
	h.deferWrite(new Promise<void>((resolve) => { finish = resolve; }));
	h.tick(29);
	h.profile();
	assert.equal(h.writeSignals[0]!.aborted, false);
	h.trace.stop();
	assert.equal(h.writeSignals[0]!.aborted, true);
	assert.equal(h.stats().hasTick, false);
	finish();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.writes.length, 1);
	assert.equal(h.stats().hasTick, false);
});

test("worker exit/error tears down sampling; a failed diagnostic logger is non-fatal", () => {
	const h = harness();
	h.trace.start(64);
	h.child.emit("error", new Error("IPC failed"));
	assert.equal(h.stats().disconnects, 1);
	assert.equal(h.stats().hasTick, false);
	assert.equal(h.child.connected, false);
	h.child.emit("exit", 1);
	const failing = new TuiMemoryTrace(() => ({}), {
		enabled: true,
		fork: () => { throw new Error("no process"); },
		log: () => { throw new Error("logger failed"); },
	});
	assert.doesNotThrow(() => failing.start(64));
});
