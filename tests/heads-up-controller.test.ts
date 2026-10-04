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
const finding = { kind: "heads_up", notices: [{ id: null, title: "Compatibility was dropped", consequence: "Existing configurations will no longer load.", evidenceIds: ["u", "t"] }] };
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
	return { observer, calls, billed, published, timers, now: () => now, advance: (ms: number) => {
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

test("automatic cadence waits for successful settlement and minimum interval; manual checks remain immediate", async () => {
	const h = harness({ config: { minTurns: 1 } }); h.observer.setEnabled(true); h.observer.noteAgentStart();
	h.observer.noteTurn({ role: "assistant", content: "Tests failed; repairing" }, "a", [], []);
	assert.equal(await h.observer.check(), false);
	h.observer.noteAgentSettled(true);
	h.advance(59_999); await flush(); assert.equal(h.calls.length, 0);
	h.advance(1); await flush(); assert.equal(h.calls.length, 1);
	h.observer.noteAgentStart(); await h.observer.check(true); assert.equal(h.calls.length, 2);
	h.observer.dispose();
});

test("delegated evidence during an active parent waits for settlement, not just its timer", async () => {
	const h = harness(); h.observer.setEnabled(true);
	h.observer.noteDelegatedCompletion(); h.observer.noteAgentStart();
	h.advance(60_000); await flush(); assert.equal(h.calls.length, 0);
	h.observer.noteDelegatedCompletion(); h.advance(60_000); await flush(); assert.equal(h.calls.length, 0);
	h.observer.noteAgentSettled(true); h.advance(0); await flush(); assert.equal(h.calls.length, 1);
	h.observer.dispose();
});

test("a parent resuming during automatic inference defers the finding until a fresh settled check", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const h = harness({ request: async () => ++calls === 1 ? pending.promise : reply(finding) });
	h.observer.setEnabled(true); h.observer.noteDelegatedCompletion(); h.advance(60_000); await flush();
	h.observer.noteAgentStart(); pending.resolve(reply(finding)); await flush();
	assert.equal(h.observer.currentNotice, null);
	assert.equal(h.observer.snapshot().reason, "agent running; awaiting fresh check");
	h.advance(60_000); await flush(); assert.equal(calls, 1);
	h.observer.noteAgentSettled(true); h.advance(0); await flush();
	assert.equal(calls, 2); assert.ok(h.observer.currentNotice); h.observer.dispose();
});

test("a completed HUD retest during inference discards the old complaint and rechecks fresh evidence", async () => {
	const pending = deferred<AssistantMessage>(); const inputs: string[] = [];
	const oldComplaint = { kind: "heads_up", notices: [{ id: null, title: "HUD tests still fail", consequence: "5 of 82 failed; no retest in records.", evidenceIds: ["failed"] }] };
	const h = harness({ request: async (request) => {
		inputs.push(request.input);
		if (inputs.length === 1) return pending.promise;
		assert.match(request.input, /82 passed/);
		return reply();
	} });
	h.observer.context.addMessage({ role: "toolResult", toolName: "codemode", content: "5 failed, 77 passed (82)" }, "failed");
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.observer.noteTurn({ role: "assistant", content: "Fixed h-7/h-6 and accessible quota-label assertions" }, "fix", [
		{ role: "toolResult", toolName: "shell", content: "Same six files: 82 passed, exit 0" },
	], ["retest"]);
	pending.resolve(reply(oldComplaint)); assert.equal(await check, false);
	assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 1);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "cancelled");
	assert.match(h.observer.snapshot().reason!, /evidence changed/);
	h.advance(59_999); await flush(); assert.equal(inputs.length, 1);
	h.advance(1); await flush(); assert.equal(inputs.length, 2);
	assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 2);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "none");
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("success of a different check does not resolve an unrelated failure on reassessment", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const h = harness({ request: async (request) => {
		if (++calls === 1) return pending.promise;
		assert.match(request.input, /Loader now rejects/);
		assert.match(request.input, /unrelated lint passed/);
		return reply(finding);
	} });
	h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
	h.observer.noteTurn({ role: "assistant", content: "Linting" }, "lint", [{ role: "toolResult", toolName: "shell", content: "unrelated lint passed" }], ["lint-result"]);
	pending.resolve(reply(finding)); assert.equal(await check, false);
	h.advance(60_000); await flush();
	assert.equal(calls, 2); assert.equal(h.observer.currentNotice?.title, finding.notices[0]!.title);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "notice");
	h.observer.dispose();
});

test("freshness rechecks obey hourly budgets and lifecycle cancellation", async () => {
	for (const stop of [false, true]) {
		const pending = deferred<AssistantMessage>(); let calls = 0;
		const h = harness({ config: { maxChecksPerHour: 1 }, request: async () => { calls++; return pending.promise; } });
		h.observer.setEnabled(true); const check = h.observer.check(true); await flush();
		h.observer.context.add({ id: "new", kind: "tool", text: "New verification result" });
		pending.resolve(reply(finding)); await check;
		if (stop) h.observer.noteUserRequest();
		h.advance(60_000); await flush(); assert.equal(calls, 1);
		assert.equal(h.observer.snapshot().phase, stop ? "idle" : "limited");
		assert.equal(h.timers.size, 0); h.observer.dispose();
	}
});

test("a finding cannot publish if its projection refresh fails or its cited text was edited", async () => {
	for (const fail of [false, true]) {
		let refreshes = 0;
		const h = harness({ request: async () => reply(finding), prepareContext: () => {
			if (++refreshes === 1) return;
			if (fail) throw new Error("projection unavailable");
			h.observer.context.reset([{ id: "u", kind: "user", text: "Keep compatibility" }, { id: "t", kind: "tool", text: "Compatibility restored" }]);
		} });
		h.observer.setEnabled(true); assert.equal(await h.observer.check(true), false);
		assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 1);
		assert.equal(h.observer.snapshot().phase, fail ? "unavailable" : "cooldown");
		h.observer.dispose(); assert.equal(h.timers.size, 0);
	}
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

test("an open HUD card is reviewed once on settled new evidence and removed after the same check passes", async () => {
	const inputs: string[] = [];
	const hudFinding = { kind: "heads_up", notices: [{ id: null, title: "HUD tests still fail", consequence: "5 of 82 failed; no retest in records.", evidenceIds: ["failed"] }] };
	const h = harness({ request: async (request) => {
		inputs.push(request.input);
		if (inputs.length === 1) return reply(hudFinding);
		const review = JSON.parse(request.input);
		assert.equal(review.activeNotices[0].title, hudFinding.notices[0]!.title);
		assert.match(request.input, /82 passed/);
		return reply();
	} });
	h.observer.context.addMessage({ role: "toolResult", toolName: "codemode", content: "5 failed, 77 passed (82)" }, "failed");
	h.observer.setEnabled(true);
	await h.observer.check(true); assert.ok(h.observer.currentNotice);
	h.observer.noteAgentStart();
	assert.equal(h.observer.currentNotice, null);
	assert.equal(h.observer.snapshot().awaitingReview, true);
	h.observer.noteTurn({ role: "assistant", content: "Fixed and verified" }, "fix", [{ role: "toolResult", toolName: "shell", content: "Same check: 82 passed" }], ["retest"]);
	h.advance(60_000); await flush(); assert.equal(inputs.length, 1);
	h.observer.noteAgentSettled(true); h.advance(0); await flush();
	assert.equal(inputs.length, 2); assert.equal(h.observer.currentNotice, null);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "none");
	h.advance(60_000); await flush(); assert.equal(inputs.length, 2, "no periodic polling");
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("review preserves an unresolved card after unrelated success without duplicating or extending its lifetime", async () => {
	const inputs: string[] = [];
	const h = harness({ request: async (request) => { inputs.push(request.input); return reply(finding); } });
	h.observer.setEnabled(true); await h.observer.check(true); const notice = h.observer.currentNotice!;
	h.observer.noteAgentStart();
	h.observer.noteTurn({ role: "assistant", content: "Progress only" }, "progress", [], []);
	h.observer.noteAgentSettled(true); h.advance(60_000); await flush();
	assert.equal(inputs.length, 2, "resuming the parent requires fresh confirmation even without tool evidence");
	h.observer.noteAgentStart();
	h.observer.noteTurn({ role: "assistant", content: "Unrelated lint" }, "lint", [{ role: "toolResult", toolName: "shell", content: "Unrelated lint passed" }], ["lint-result"]);
	h.observer.noteAgentSettled(true); h.advance(60_000); await flush();
	assert.equal(inputs.length, 3); assert.match(inputs[2]!, /Unrelated lint passed/);
	assert.equal(h.observer.currentNotice?.id, notice.id);
	assert.equal(h.observer.currentNotice?.expiresAt, notice.expiresAt);
	assert.equal(h.observer.currentNotice?.createdAt, notice.createdAt);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "notice", "review bypasses duplicate suppression for its own card");
	h.advance(notice.expiresAt - h.now()); assert.equal(h.observer.currentNotice, null); h.observer.dispose();
});

test("late card review cannot resurrect dismissed or expired notices", async () => {
	for (const dismissal of ["dismiss", "expiry"] as const) {
		const pending = deferred<AssistantMessage>(); let calls = 0;
		const h = harness({ config: { noticeTtlMs: 30_000, timeoutMs: 60_000 }, request: async () => ++calls === 1 ? reply(finding) : pending.promise });
		h.observer.setEnabled(true); await h.observer.check(true); const notice = h.observer.currentNotice!;
		const check = h.observer.check(true); await flush();
		if (dismissal === "dismiss") h.observer.feedbackNotice(notice.id, "dismiss");
		else h.advance(notice.expiresAt - h.now());
		pending.resolve(reply(finding)); assert.equal(await check, false);
		assert.equal(h.observer.currentNotice, null); assert.equal(h.billed.length, 2);
		assert.equal(h.observer.snapshot().details?.lastCheck?.result, "cancelled"); h.observer.dispose();
	}
});

test("updated review wording remains deduplicated after dismissal", async () => {
	let calls = 0;
	const updated = { ...finding.notices[0]!, consequence: "The updated caller still cannot use this async loader." };
	const h = harness({ request: async (request) => reply(++calls === 1 ? finding : { kind: "heads_up", notices: [{ ...updated, id: JSON.parse(request.input).activeNotices[0]?.id ?? null }] }) });
	h.observer.setEnabled(true); await h.observer.check(true); await h.observer.check(true);
	assert.equal(h.observer.currentNotice?.consequence, updated.consequence);
	h.observer.feedbackNotice(h.observer.currentNotice!.id, "dismiss");
	assert.equal(await h.observer.check(true), false); assert.equal(h.observer.currentNotice, null);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "duplicate"); h.observer.dispose();
});

test("stale none from a review cannot remove a card after newer failure evidence", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const h = harness({ request: async () => ++calls === 1 ? reply(finding) : pending.promise });
	h.observer.setEnabled(true); await h.observer.check(true); const notice = h.observer.currentNotice!;
	const check = h.observer.check(true); await flush();
	h.observer.context.add({ id: "still-fails", kind: "tool", text: "Compatibility still fails" });
	pending.resolve(reply()); assert.equal(await check, false);
	assert.equal(h.observer.currentNotice, null);
	assert.equal(h.observer.explain(notice.id), null);
	assert.equal(h.observer.snapshot().awaitingReview, true);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "cancelled");
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("review refusal and invalid replies keep unconfirmed cards hidden under their original TTL", async () => {
	for (const limited of [false, true]) {
		let calls = 0;
		const h = harness({ config: { maxChecksPerHour: limited ? 1 : 10 }, request: async () => ++calls === 1 ? reply(finding) : reply("not-json") });
		h.observer.setEnabled(true); await h.observer.check(true); const notice = h.observer.currentNotice!;
		h.observer.noteAgentStart(); h.observer.noteTurn({ role: "assistant", content: "working" }, "a", [{ role: "toolResult", content: "new result" }], ["new"]);
		h.observer.noteAgentSettled(true); h.advance(60_000); await flush();
		assert.equal(calls, limited ? 1 : 2); assert.equal(h.observer.currentNotice, null);
		assert.deepEqual(h.observer.snapshot().notices, []); assert.equal(h.observer.snapshot().awaitingReview, true);
		assert.equal(h.observer.snapshot().phase, limited ? "limited" : "error");
		h.advance(notice.expiresAt - h.now()); assert.equal(h.observer.currentNotice, null);
		assert.equal(h.observer.snapshot().awaitingReview, false); assert.equal(calls, limited ? 1 : 2, "no error or budget retry loop"); h.observer.dispose();
	}
});

test("new evidence hides the entire stack immediately; only a supported fresh subset returns with original TTL", async () => {
	const pending = deferred<AssistantMessage>(); const inputs: string[] = [];
	const second = { ...finding.notices[0]!, title: "Other issue", consequence: "Independent consequence" };
	const h = harness({ request: async (request) => { inputs.push(request.input); return inputs.length === 1 ? reply({ kind: "heads_up", notices: [...finding.notices, second] }) : pending.promise; } });
	h.observer.setEnabled(true); await h.observer.check(true);
	const original = h.observer.snapshot().notices!;
	h.observer.noteEvidenceChanged();
	assert.equal(h.published.at(-1)?.notice, null); assert.deepEqual(h.published.at(-1)?.notices, []);
	assert.equal(h.observer.selectNotice(1), false); assert.equal(h.observer.explain(original[0]!.id), null);
	h.observer.context.add({ id: "new", kind: "tool", text: "One issue fixed, other remains" });
	const check = h.observer.check(true); await flush();
	assert.equal(JSON.parse(inputs[1]!).activeNotices.length, 2);
	pending.resolve(reply({ kind: "heads_up", notices: [{ ...second, id: original[1]!.id, evidenceIds: ["new"] }] }));
	assert.equal(await check, true);
	assert.equal(h.observer.snapshot().notices?.length, 1); assert.equal(h.observer.snapshot().awaitingReview, false);
	assert.equal(h.observer.currentNotice?.id, original[1]!.id); assert.equal(h.observer.currentNotice?.expiresAt, original[1]!.expiresAt);
	h.observer.dispose();
});

test("evidence completion before persistence rejects a review; even a manual check cannot restore while parent runs", async () => {
	for (const event of ["evidence", "parent", "parent-settled"] as const) {
		const pending = deferred<AssistantMessage>(); let calls = 0;
		const h = harness({ request: async () => ++calls === 1 ? reply(finding) : pending.promise });
		h.observer.setEnabled(true); await h.observer.check(true);
		const check = h.observer.check(true); await flush();
		if (event === "evidence") h.observer.noteEvidenceChanged();
		else { h.observer.noteAgentStart(); if (event === "parent-settled") h.observer.noteAgentSettled(true); }
		pending.resolve(reply(finding)); assert.equal(await check, false);
		assert.equal(h.observer.currentNotice, null); assert.equal(h.observer.snapshot().awaitingReview, true);
		assert.equal(h.observer.snapshot().details?.lastCheck?.result, "cancelled"); assert.equal(h.billed.length, 2);
		h.observer.dispose(); assert.equal(h.timers.size, 0);
	}
});

test("hidden cards remain hidden after error, timeout, missing model or insufficient context without retrying", async () => {
	for (const failure of ["error", "timeout", "model", "context"] as const) {
		let calls = 0; let available = true;
		const pending = deferred<AssistantMessage>();
		const h = harness({ findModel: () => available ? model : undefined, request: async () => {
			if (++calls === 1) return reply(finding);
			if (failure === "timeout") return pending.promise;
			throw new Error("provider failure");
		} });
		h.observer.setEnabled(true); await h.observer.check(true);
		h.observer.noteEvidenceChanged();
		if (failure === "model") available = false;
		if (failure === "context") h.observer.context.reset();
		const check = h.observer.check(true); await flush();
		if (failure === "timeout") h.advance(20_000);
		await check;
		assert.equal(h.observer.currentNotice, null); assert.equal(h.observer.snapshot().awaitingReview, true);
		h.advance(60_000); await flush(); assert.equal(calls, failure === "model" || failure === "context" ? 1 : 2);
		if (failure === "timeout") { pending.resolve(reply(finding)); await flush(); assert.equal(h.observer.currentNotice, null); }
		h.observer.dispose(); assert.equal(h.timers.size, 0);
	}
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

test("one request reviews existing cards and discovers others, using only one reservation", async () => {
	const inputs: string[] = [];
	const h = harness({ request: async ({ input }) => {
		inputs.push(input);
		const active = JSON.parse(input).activeNotices;
		if (!active.length) return reply(finding);
		return reply({ kind: "heads_up", notices: [
			{ ...finding.notices[0], id: active[0].id },
			{ id: null, title: "Billing duplicated", consequence: "Retry billed twice", evidenceIds: ["new"] },
			{ id: null, title: "Tenant leaked", consequence: "Shared cache crosses tenants", evidenceIds: ["new"] },
		] });
	} });
	h.observer.setEnabled(true); await h.observer.check(true);
	const original = h.observer.currentNotice!;
	h.observer.noteAgentStart();
	h.observer.noteTurn({ role: "assistant", content: "Finished" }, "a", [{ role: "toolResult", content: "Retry billed twice; shared cache leaked tenant data" }], ["new"]);
	h.observer.noteAgentSettled(true); h.advance(60_000); await flush();
	assert.equal(inputs.length, 2); assert.equal(h.observer.snapshot().checks, 2); assert.equal(h.billed.length, 2);
	const cards = h.observer.snapshot().notices!;
	assert.equal(cards.length, 3); assert.equal(cards[0]?.id, original.id); assert.equal(cards[0]?.expiresAt, original.expiresAt);
	assert.equal(h.observer.currentNotice?.id, original.id);
	assert.equal(h.observer.selectNotice(1), true); assert.equal(h.observer.currentNotice?.title, "Billing duplicated");
	assert.equal(h.observer.snapshot().checks, 2, "navigation is free");
	h.advance(original.expiresAt - h.now());
	assert.equal(h.observer.snapshot().notices?.length, 2, "each card has its own expiry");
	h.observer.dispose(); assert.equal(h.timers.size, 0);
});

test("removing one card while assessment runs cannot resurrect it or alter other cards", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const first = { kind: "heads_up", notices: [finding.notices[0], { ...finding.notices[0], title: "Independent conflict" }] };
	const h = harness({ request: async () => ++calls === 1 ? reply(first) : pending.promise });
	h.observer.setEnabled(true); await h.observer.check(true);
	const [one, two] = h.observer.snapshot().notices!;
	const check = h.observer.check(true); await flush();
	h.observer.feedbackNotice(one!.id, "dismiss");
	pending.resolve(reply({ kind: "heads_up", notices: [{ ...finding.notices[0], id: one!.id }, { ...first.notices[1], id: two!.id }] }));
	assert.equal(await check, false);
	assert.deepEqual(h.observer.snapshot().notices?.map((card) => card.id), [two!.id]);
	assert.equal(h.observer.snapshot().details?.lastCheck?.result, "cancelled");
	assert.equal(h.billed.length, 2); h.observer.dispose();
});

test("navigation during assessment does not cancel it; unsupported card removal preserves selected survivor", async () => {
	const pending = deferred<AssistantMessage>(); let calls = 0;
	const h = harness({ request: async () => ++calls === 1 ? reply({ kind: "heads_up", notices: [finding.notices[0], { ...finding.notices[0], title: "Second conflict" }] }) : pending.promise });
	h.observer.setEnabled(true); await h.observer.check(true);
	const second = h.observer.snapshot().notices![1]!;
	const check = h.observer.check(true); await flush(); h.observer.selectNotice(1);
	pending.resolve(reply({ kind: "heads_up", notices: [{ id: second.id, title: second.title, consequence: second.consequence, evidenceIds: ["t"] }] }));
	assert.equal(await check, true); assert.equal(h.observer.currentNotice?.id, second.id);
	assert.equal(h.observer.snapshot().notices?.length, 1); h.observer.dispose();
});
