import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { HeadsUpController, type HeadsUpControllerOptions, type HeadsUpRequest } from "../src/bundled-extensions/heads-up/controller.js";
import { observerUsageRecorder } from "../src/bundled-extensions/heads-up/usage.js";

const model = { provider: "openai-codex", id: "gpt-6-luna" } as Model<Api>;
function reply(value: unknown = { kind: "none" }, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: model.provider, model: model.id,
		content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop", timestamp: 0,
		usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, totalTokens: 19, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...overrides,
	};
}
const finding = { kind: "heads_up", title: "Compatibility was dropped", consequence: "Existing configurations will no longer load.", evidenceIds: ["u", "t"] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("delegated completion near parent finish coalesces without fake turns or bypassing cadence/budget", async () => {
	const h = harness({ config: { maxChecksPerHour: 1 } }); h.observer.setEnabled(true);
	h.observer.noteDelegatedCompletion(); h.observer.noteDelegatedCompletion();
	assert.equal(h.observer.snapshot().details?.newTurns, 0);
	h.advance(59_999); await flush(); assert.equal(h.calls.length, 0);
	h.advance(1); await flush(); assert.equal(h.calls.length, 1);
	h.observer.noteDelegatedCompletion(); h.advance(60_000); await flush();
	assert.equal(h.calls.length, 1); assert.equal(h.observer.snapshot().phase, "limited");
	assert.equal(h.timers.size, 0); h.observer.dispose();
});

test("delegated arrivals during transport wait for physical completion and retain interval", async () => {
	const pending = deferred<AssistantMessage>(); let count = 0;
	const h = harness({ request: async () => { count++; return count === 1 ? pending.promise : reply(); } });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.observer.noteDelegatedCompletion(); h.observer.noteDelegatedCompletion();
	h.advance(1000); await flush(); assert.equal(count, 1);
	pending.resolve(reply()); await check; h.advance(58_999); await flush(); assert.equal(count, 1);
	h.advance(1); await flush(); assert.equal(count, 2); h.observer.dispose();
});

test("delegated pending timers are cancelled by lifecycle invalidation and disable", async () => {
	for (const invalidate of [(o: HeadsUpController) => o.invalidateForLifecycle("branch"), (o: HeadsUpController) => o.setEnabled(false), (o: HeadsUpController) => o.dispose()]) {
		const h = harness(); h.observer.setEnabled(true); h.observer.noteDelegatedCompletion();
		invalidate(h.observer); h.advance(60_000); await flush();
		assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); h.observer.dispose();
	}
});
function harness(overrides: Partial<HeadsUpControllerOptions> = {}) {
	let now = 0;
	const timers = new Map<symbol, { at: number; callback: () => void }>();
	const calls: HeadsUpRequest[] = [];
	const billed: AssistantMessage[] = [];
	const published: ReturnType<HeadsUpController["snapshot"]>[] = [];
	const observer = new HeadsUpController({
		now: () => now,
		after: (ms, callback) => { const key = Symbol(); timers.set(key, { at: now + ms, callback }); return () => { timers.delete(key); }; },
		findModel: () => model, request: async (request) => { calls.push(request); return reply(); },
		canAccountUsage: () => true, accountUsage: (message) => { billed.push(message); }, publish: (state) => { published.push(state); },
		...overrides,
	});
	observer.context.add({ id: "u", kind: "user", text: "Keep existing config compatibility." });
	observer.context.add({ id: "t", kind: "tool", text: "Loader now rejects old configuration format." });
	return { observer, calls, billed, published, timers, advance: (ms: number) => {
		now += ms;
		for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
	} };
}

test("observer is off by default and requires explicit opt-in", async () => {
	const h = harness();
	assert.equal(await h.observer.check(true), false);
	assert.equal(h.calls.length, 0);
	h.observer.setEnabled(true); await h.observer.check(true);
	assert.equal(h.calls.length, 1); assert.equal(h.billed.length, 1);
	assert.equal(h.observer.snapshot().inputTokens, 16);
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("cadence counts six agent turns in one user request, and enforces elapsed time", async () => {
	const h = harness(); h.observer.setEnabled(true); h.observer.noteUserRequest();
	for (let i = 0; i < 6; i++) {
		h.observer.noteTurn({ role: "assistant", content: "working" }, `a${i}`, [], []);
		await h.observer.check();
	}
	assert.equal(h.calls.length, 0);
	h.advance(60_000); await h.observer.check(); assert.equal(h.calls.length, 1);
	await h.observer.check(); assert.equal(h.calls.length, 1);
	h.observer.dispose();
});

test("explicit checks bypass cadence, not hourly budget; toggles and model changes do not reset it", async () => {
	const h = harness({ config: { maxChecksPerHour: 1 } }); h.observer.setEnabled(true);
	await h.observer.check(true); h.observer.setEnabled(false); h.observer.setEnabled(true); h.observer.setModel("other/model");
	await h.observer.check(true); assert.equal(h.calls.length, 1); assert.equal(h.observer.snapshot().phase, "limited");
	h.advance(3_600_001); await h.observer.check(true); assert.equal(h.calls.length, 2); h.observer.dispose();
});

test("input reservation cap cannot be bypassed with manual check", async () => {
	const h = harness({ config: { maxInputCharsPerHour: 2000 } }); h.observer.setEnabled(true);
	h.observer.context.add({ id: "large", kind: "tool", text: "x".repeat(2500) });
	await h.observer.check(true); assert.equal(h.calls.length, 0); assert.equal(h.observer.snapshot().phase, "limited"); h.observer.dispose();
});

test("offline/unsupported runtime, absent model or absent accounting never makes an inference", async () => {
	for (const overrides of [{ allowed: () => false }, { findModel: () => undefined }, { canAccountUsage: () => false }]) {
		const h = harness(overrides); h.observer.setEnabled(true); await h.observer.check(true);
		assert.equal(h.calls.length, 0); h.observer.dispose();
	}
});

test("timeout aborts transport and retains physical lock if provider ignores abort", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0; let signal!: AbortSignal;
	const h = harness({ config: { timeoutMs: 1000 }, request: async (request) => { calls++; signal = request.signal; return pending.promise; } });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.advance(1000); await check;
	assert.equal(signal.aborted, true); assert.equal(h.observer.snapshot().reason, "check timed out");
	await h.observer.check(true); assert.equal(calls, 1);
	pending.resolve(reply(finding)); await flush();
	assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 1);
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("disable cancels without waiting; cannot overlap with a still-running cancelled request", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const h = harness({ request: async () => { calls++; return pending.promise; } });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.observer.setEnabled(false); await check;
	h.observer.setEnabled(true); await h.observer.check(true); assert.equal(calls, 1);
	pending.resolve(reply(finding)); await flush(); assert.equal(h.observer.currentNotice, null);
	h.observer.dispose();
});

test("new request, branch change, model change, shutdown discard late findings but still account usage", async () => {
	for (const invalidate of [
		(o: HeadsUpController) => o.noteUserRequest(),
		(o: HeadsUpController) => o.invalidateForLifecycle("branch changing", true),
		(o: HeadsUpController) => o.setModel("other/model"),
		(o: HeadsUpController) => o.dispose(),
	]) {
		const pending = deferred<AssistantMessage>();
		const h = harness({ request: async () => pending.promise }); h.observer.setEnabled(true);
		const check = h.observer.check(true); await flush(); invalidate(h.observer); await check;
		pending.resolve(reply(finding)); await flush();
		assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 1); h.observer.dispose();
	}
});

test("ordinary later turns do not invalidate a pending finding", async () => {
	const pending = deferred<AssistantMessage>(); const h = harness({ request: async () => pending.promise });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.observer.noteTurn({ role: "assistant", content: "unrelated normal progress" }, "a2", [], []);
	pending.resolve(reply(finding)); assert.equal(await check, true); assert.ok(h.observer.currentNotice); h.observer.dispose();
});

test("same notice is deduplicated and feedback is included in later requests; stale IDs cannot dismiss a newer card", async () => {
	const calls: string[] = [];
	const h = harness({ request: async (request) => { calls.push(request.input); return reply(finding); } });
	h.observer.setEnabled(true); await h.observer.check(true);
	const notice = h.observer.currentNotice!;
	assert.equal(h.observer.feedbackNotice("stale-id", "dismiss"), false);
	assert.equal(h.observer.feedbackNotice(notice.id, "known"), true);
	assert.equal(await h.observer.check(true), false); assert.equal(h.observer.currentNotice, null);
	assert.match(calls[1]!, /known: Compatibility/); h.observer.dispose();
});

test("notice expires during idle and teardown releases expiry timers", async () => {
	const h = harness({ config: { noticeTtlMs: 30_000 }, request: async () => reply(finding) }); h.observer.setEnabled(true);
	await h.observer.check(true); assert.ok(h.observer.currentNotice); h.advance(30_000);
	assert.equal(h.observer.currentNotice, null); assert.equal(h.published.at(-1)?.notice, null);
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("synchronous provider throws and truncated/error responses do not escape or show a notice", async () => {
	for (const request of [
		() => { throw new Error("secret provider detail"); },
		async () => reply(finding, { stopReason: "length" }),
		async () => reply(finding, { stopReason: "error" }),
	]) {
		const h = harness({ request }); h.observer.setEnabled(true); await h.observer.check(true);
		assert.equal(h.observer.currentNotice, null); assert.doesNotMatch(JSON.stringify(h.observer.snapshot()), /secret provider detail/); h.observer.dispose();
	}
});

test("projected context refresh happens only for a real check, not every skipped event", async () => {
	let refreshes = 0;
	const h = harness({ prepareContext: () => { refreshes++; } });
	await h.observer.check(); assert.equal(refreshes, 0); h.observer.setEnabled(true);
	for (let i = 0; i < 10; i++) await h.observer.check(); assert.equal(refreshes, 0);
	await h.observer.check(true); assert.equal(refreshes, 1); h.observer.dispose();
});

test("late usage goes only to original captured manager; disposed UI receives no late push", async () => {
	const original: unknown[] = []; const other: unknown[] = [];
	const manager = { getSessionId: () => "original", appendUsage: (...args: unknown[]) => original.push(args) };
	const recorder = observerUsageRecorder(manager as unknown as Parameters<typeof observerUsageRecorder>[0]);
	const pending = deferred<AssistantMessage>();
	const h = harness({ request: async () => pending.promise, canAccountUsage: recorder.available, accountUsage: recorder.record });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush(); h.observer.dispose(); await check;
	const count = h.published.length;
	const fresh = harness({ accountUsage: (message) => { other.push(message); } });
	pending.resolve(reply()); await flush();
	assert.equal(original.length, 1); assert.equal(other.length, 0); assert.equal(h.published.length, count); fresh.observer.dispose();
});

test("accounting failure prevents subsequent requests instead of silently losing spend", async () => {
	const h = harness({ accountUsage: () => { throw new Error("write failed"); } }); h.observer.setEnabled(true);
	await h.observer.check(true); await h.observer.check(true);
	assert.equal(h.calls.length, 1); assert.equal(h.observer.snapshot().reason, "usage accounting unavailable"); h.observer.dispose();
});
