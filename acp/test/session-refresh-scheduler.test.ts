import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { SessionRefreshScheduler } from "../src/acp/session-refresh-scheduler.js";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("refresh lanes retain only the latest pending operation across asynchronous bursts", async () => {
	const errors: unknown[] = [];
	const queue = new SessionRefreshScheduler((error) => { errors.push(error); });
	const owner = {};
	const blocked = gate();
	const calls: number[] = [];
	queue.schedule(owner, "context", async () => { calls.push(0); await blocked.promise; });
	await tick();
	for (let i = 1; i <= 100; i++) {
		queue.schedule(owner, "context", async () => { calls.push(i); });
		await tick();
	}
	assert.deepEqual(calls, [0]);
	blocked.resolve();
	await tick();
	assert.deepEqual(calls, [0, 100]);
	assert.deepEqual(errors, []);
	queue.schedule(owner, "context", async () => { calls.push(101); });
	await tick();
	assert.deepEqual(calls, [0, 100, 101], "completed lanes can be reused");
});

test("different runtime owners and refresh kinds do not block each other", async () => {
	const errors: unknown[] = [];
	const queue = new SessionRefreshScheduler((error) => { errors.push(error); });
	const owner = {};
	const blocked = gate();
	const calls: string[] = [];
	queue.schedule(owner, "context", async () => { await blocked.promise; });
	queue.schedule(owner, "model", async () => { calls.push("model"); });
	queue.schedule({}, "context", async () => { calls.push("other"); });
	await tick();
	assert.deepEqual(calls, ["model", "other"]);
	blocked.resolve();
	await tick();
	assert.deepEqual(errors, []);
});

test("forget drops scheduled and pending work without old cleanup erasing a new owner lane", async () => {
	const errors: unknown[] = [];
	const queue = new SessionRefreshScheduler((error) => { errors.push(error); });
	const owner = {};
	const old = gate();
	const current = gate();
	const calls: string[] = [];
	queue.schedule(owner, "config", async () => { calls.push("old"); await old.promise; });
	await tick();
	queue.schedule(owner, "config", async () => { calls.push("discard"); });
	queue.forget(owner);
	queue.schedule(owner, "config", async () => { calls.push("current"); await current.promise; });
	await tick();
	old.resolve();
	await tick();
	queue.schedule(owner, "config", async () => { calls.push("latest"); });
	await tick();
	assert.deepEqual(calls, ["old", "current"]);
	current.resolve();
	await tick();
	assert.deepEqual(calls, ["old", "current", "latest"]);
	queue.schedule(owner, "context", async () => { calls.push("discard scheduled"); });
	queue.forget(owner);
	await tick();
	assert.deepEqual(calls, ["old", "current", "latest"]);
	assert.deepEqual(errors, []);
});

test("rejection and a throwing logger do not strand the pending refresh or lane", async () => {
	const expected = new Error("RPC failed");
	const errors: unknown[] = [];
	const queue = new SessionRefreshScheduler((error) => { errors.push(error); throw new Error("logger failed"); });
	const owner = {};
	const blocked = gate();
	let completed = 0;
	queue.schedule(owner, "model", async () => { await blocked.promise; throw expected; });
	await tick();
	queue.schedule(owner, "model", async () => { completed++; });
	blocked.resolve();
	await tick();
	assert.deepEqual(errors, [expected]);
	assert.equal(completed, 1);
	queue.schedule(owner, "model", async () => { completed++; });
	await tick();
	assert.equal(completed, 2);
});
