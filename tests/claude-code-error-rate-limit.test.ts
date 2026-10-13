import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCodeErrorRateLimit } from "../src/app/model/claude-code-error-rate-limit.js";

const failure = (clock = "12:10am", zone = "Europe/Warsaw") => ({
	role: "assistant", provider: "pi-claude-code-provider", model: "opus", stopReason: "error",
	errorMessage: `Claude Code request failed (429): You've hit your session limit · resets ${clock} (${zone})`,
});

describe("Claude Code terminal quota rejection", () => {
	it("maps the recorded local clocks to the correct reset date, including midnight", () => {
		for (const [now, clock, reset] of [
			["2026-10-12T14:08:00Z", "7:10pm", "2026-10-12T17:10:00Z"],
			["2026-10-12T19:20:00Z", "12:10am", "2026-10-12T22:10:00Z"],
			["2026-10-12T20:56:00Z", "12:10am", "2026-10-12T22:10:00Z"],
			["2026-10-12T23:33:00Z", "5:10am", "2026-10-13T03:10:00Z"],
		]) {
			const sample = claudeCodeErrorRateLimit(failure(clock), "session", Date.parse(now!))!;
			assert.equal(sample.resetsAt, Date.parse(reset!));
			assert.equal(sample.status, "rejected");
			assert.equal(sample.rateLimitType, "five_hour");
			assert.equal(sample.modelRef, "pi-claude-code-provider/opus");
			assert.equal(sample.resetPrecision, "minute");
		}
	});

	it("handles a unique DST reset and rejects nonexistent or ambiguous wall clocks", () => {
		assert.equal(claudeCodeErrorRateLimit(failure("4am"), "a", Date.parse("2026-03-29T00:00:00Z"))?.resetsAt,
			Date.parse("2026-03-29T02:00:00Z"));
		assert.equal(claudeCodeErrorRateLimit(failure("2:30am"), "a", Date.parse("2026-03-29T00:00:00Z")), undefined);
		assert.equal(claudeCodeErrorRateLimit(failure("2:30am"), "a", Date.parse("2026-10-24T23:00:00Z")), undefined);
	});

	it("does not infer quota from generic errors, other routes or unreliable reset clocks", () => {
		const now = Date.parse("2026-10-12T20:56:00Z");
		for (const message of [
			{ ...failure(), provider: "anthropic" }, { ...failure(), role: "user" }, { ...failure(), stopReason: "aborted" },
			{ ...failure(), errorMessage: "Claude Code request failed (429): Too many requests" },
			{ ...failure(), errorMessage: failure().errorMessage.replace("session limit", "weekly limit") },
			failure("13pm"), failure("0am"), failure("12:60am"), failure("12am", "not-a-zone"), failure("9pm"),
		]) assert.equal(claudeCodeErrorRateLimit(message, "a", now), undefined);
	});
});
