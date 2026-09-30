import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isQuotaCandidate, isQuotaExhaustion, parseQuotaWait, parseWaitDuration, parseWaitDeadline, quotaFromError, quotaRetryDelay, QuotaWaitController, type QuotaCheck, type QuotaWaitState } from "../src/app/session/quota-wait.js";
import { quotaWaitLabel } from "../src/bundled-extensions/quota-wait/popup.js";

function fixture(check: () => Promise<QuotaCheck> = async () => ({ kind: "unknown" })) {
	let now = 1_000_000;
	let resumes = 0;
	let idle = true;
	const changes: (QuotaWaitState | undefined)[] = [];
	const controller = new QuotaWaitController({ now: () => now, check, canResume: () => idle,
		resume: () => { resumes++; }, changed: (state) => changes.push(state) });
	return { controller, changes, get resumes() { return resumes; }, setNow: (value: number) => { now = value; }, setIdle: (value: boolean) => { idle = value; } };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("quota wait", () => {
	it("accepts future zoned timestamps without shifting the absolute deadline", () => {
		const now = Date.parse("2026-02-01T00:00:00Z");
		assert.equal(parseWaitDeadline("until 2026-02-01T03:20:00+03:00", now), now + 1_200_000);
		for (const value of ["2026-02-02T00:00:00Z", "until 2026-02-02T00:00", "until 2026-02-01T00:00:00Z", "until 2026-02-30T00:00:00Z", "until 2026-02-02T24:00:00Z", "until 2026-04-01T00:00:00Z"]) {
			assert.equal(parseWaitDeadline(value, now), undefined, value);
		}
		const f = fixture();
		f.controller.schedule("p/m", now + 1_200_000);
		assert.equal(f.controller.state?.notBefore, now + 1_200_000);
		assert.equal(f.controller.state?.nextCheckAt, now + 1_200_000);
	});
	it("accepts complete compound durations and rejects invalid or excessive waits", () => {
		assert.equal(parseWaitDuration("1h20m"), 4_800_000);
		assert.equal(parseWaitDuration("1D2H30M"), 95_400_000);
		assert.equal(parseWaitDuration("1.5h"), 5_400_000);
		for (const text of ["", "0s", "0.1s", "-1h", "1h garbage", "1h 20m", "100d", "Infinityh"]) assert.equal(parseWaitDuration(text), undefined, text);
	});
	it("manual timers preserve their deadline on restore, then check before resuming", async () => {
		let checks = 0;
		const f = fixture(async () => { checks++; return { kind: "available" }; });
		f.controller.manual("p/m", 4_800_000);
		const saved = f.controller.state!;
		f.setNow(2_000_000); f.controller.restore(saved); await flush();
		assert.equal(checks, 1); assert.equal(f.resumes, 0); assert.equal(f.controller.state?.nextCheckAt, 5_800_000);
		f.setNow(5_800_000); f.controller.tick(); await flush();
		assert.equal(checks, 2); assert.equal(f.resumes, 1);
	});
	it("timer expiry remains waiting if quota is still exhausted, Try now overrides deadline", async () => {
		const f = fixture(async () => ({ kind: "exhausted", window: "weekly", resetAt: 10_000_000 }));
		f.controller.manual("p/m", 1000); f.setNow(1_001_000); f.controller.tick(); await flush();
		assert.equal(f.resumes, 0); assert.equal(f.controller.state?.nextCheckAt, 10_060_000);
		await f.controller.check(true); assert.equal(f.resumes, 1);
	});
	it("separates subscription exhaustion from ordinary errors and billing", () => {
		for (const text of ["usage_limit_reached", "You've hit your limit · resets 2am", "You have hit your ChatGPT usage limit. Try again in ~10 min.", "Weekly limit exceeded", "5-hour limit reached"]) assert.equal(isQuotaExhaustion(text), true, text);
		for (const text of ["429 Too many requests", "rate limit exceeded", "insufficient_quota", "weekly quota exceeded: billing required", "maximum context length", "401 unauthorized", "503 overloaded", "fetch failed"]) assert.equal(isQuotaExhaustion(text), false, text);
		assert.equal(isQuotaCandidate("insufficient_quota"), false);
		assert.equal(isQuotaCandidate("429 Too many requests"), true);
	});
	it("parses only unambiguous reset hints", () => {
		assert.deepEqual(quotaFromError("weekly limit reached; resets_at: 2000000000", 1000), { kind: "exhausted", window: "weekly" });
		assert.deepEqual(quotaFromError("Try again in ~10 min.", 1000), { kind: "exhausted", window: "unknown", resetAt: 601000 });
		assert.deepEqual(quotaFromError("limit resets 2am (America/New_York)", 1000), { kind: "exhausted", window: "unknown" });
		const now = Date.parse("2026-09-30T00:00:00Z");
		assert.equal((quotaFromError('weekly limit resets_at: "2026-10-01T00:00:00Z"', now) as { resetAt: number }).resetAt, now + 86400000);
	});
	it("waits for known reset, then checks before one continuation", async () => {
		let checks = 0;
		const f = fixture(async () => { checks++; return { kind: "available" }; });
		f.controller.wait("p/m", "weekly", { kind: "exhausted", window: "weekly", resetAt: 2_000_000 });
		f.setNow(2_000_000); f.controller.tick(); assert.equal(checks, 0);
		f.setNow(2_059_999); f.controller.tick(); assert.equal(checks, 0);
		f.setNow(2_060_000); f.controller.tick(); f.controller.tick(); await flush();
		assert.equal(checks, 1); assert.equal(f.resumes, 1);
		f.controller.tick(); await flush(); assert.equal(f.resumes, 1);
	});
	it("unknown availability probes and repeated exhaustion backs off", async () => {
		const f = fixture();
		f.controller.wait("p/m", "limit", { kind: "unknown" });
		assert.equal(f.controller.state?.nextCheckAt, 1_060_000);
		f.setNow(1_060_000); f.controller.tick(); await flush(); assert.equal(f.resumes, 1);
		f.controller.wait("p/m", "limit", { kind: "unknown" });
		assert.equal(f.controller.state?.nextCheckAt, 1_180_000);
		assert.equal(quotaRetryDelay(1000), 900_000);
	});
	it("unavailable endpoint defers automatically but manual probe overrides", async () => {
		const f = fixture(async () => ({ kind: "failed" }));
		f.controller.wait("p/m", "limit", { kind: "unknown" });
		await f.controller.check(); assert.equal(f.resumes, 0);
		await f.controller.check(true); assert.equal(f.resumes, 1);
	});
	it("reopening immediately checks old future deadlines and cancelled waits never auto-run", async () => {
		const f = fixture(async () => ({ kind: "available" }));
		f.controller.wait("p/m", "limit", { kind: "exhausted", window: "weekly", resetAt: 99_000_000 });
		const saved = f.controller.state!;
		f.controller.restore(saved); await flush(); assert.equal(f.resumes, 1);
		const cancelled = fixture(async () => ({ kind: "available" }));
		cancelled.controller.restore({ ...saved, autoResume: false }); await flush();
		assert.equal(cancelled.resumes, 0); assert.equal(cancelled.controller.state, undefined);
	});
	it("stale checks cannot undo cancellation, clear, replacement or disposal", async () => {
		for (const invalidation of ["cancel", "clear", "wait", "dispose"] as const) {
			let resolve!: (check: QuotaCheck) => void;
			const f = fixture(() => new Promise((done) => { resolve = done; }));
			f.controller.wait("p/m", "limit", { kind: "unknown" });
			const work = f.controller.check();
			if (invalidation === "wait") f.controller.wait("other/model", "new", { kind: "unknown" });
			else f.controller[invalidation]();
			const count = f.changes.length;
			resolve({ kind: "available" }); await work;
			assert.equal(f.resumes, 0, invalidation); assert.equal(f.changes.length, count, invalidation);
		}
	});
	it("coalesces manual checks and never resumes a busy session", async () => {
		let resolve!: (check: QuotaCheck) => void;
		let checks = 0;
		const f = fixture(() => { checks++; return new Promise((done) => { resolve = done; }); });
		f.controller.wait("p/m", "limit", { kind: "unknown" }); f.setIdle(false);
		const work = f.controller.check(true); await f.controller.check(true);
		assert.equal(checks, 1); resolve({ kind: "available" }); await work;
		assert.equal(f.resumes, 0); assert.equal(f.controller.state?.phase, "waiting");
	});
	it("cancel remains durable across a failed manual probe", async () => {
		const f = fixture(); f.controller.wait("p/m", "limit", { kind: "unknown" });
		f.controller.cancel(); await f.controller.check(true); assert.equal(f.resumes, 1);
		f.controller.wait("p/m", "limit", { kind: "unknown" });
		assert.equal(f.controller.state?.autoResume, false);
		f.setNow(99_000_000); f.controller.tick(); await flush(); assert.equal(f.resumes, 1);
	});
	it("validates persistence and calculates long weekly countdowns", () => {
		const f = fixture(); f.controller.wait("p/m", "limit", { kind: "unknown" });
		assert.equal(parseQuotaWait({ ...f.controller.state, phase: "checking" })?.phase, "waiting");
		for (const malformed of [null, {}, { ...f.controller.state, attempt: -1 }, { ...f.controller.state, resetAt: Infinity }]) assert.equal(parseQuotaWait(malformed), undefined);
		assert.match(quotaWaitLabel({ ...f.controller.state!, nextCheckAt: 604800000, window: "weekly" }, 0), /168h 0m$/);
	});
});
