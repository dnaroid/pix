import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCodeRateLimitCache, parseClaudeCodeRateLimitSample } from "../src/app/model/claude-code-rate-limits.js";
import type { ModelUsageStatus } from "../src/app/model/model-usage-status.js";
import { anthropicUsageStatusFromResponse } from "../src/app/model/model-usage-status.js";

const NOW = Date.UTC(2026, 9, 12);
const MODEL = "pi-claude-code-provider/opus";
const sample = (overrides: Record<string, unknown> = {}) => ({
	version: 1, sessionId: "a", modelRef: MODEL, rateLimitType: "five_hour",
	status: "allowed_warning", utilization: 0.93, resetsAt: NOW + 3600_000, observedAt: NOW,
	...overrides,
});
const baseline = (): ModelUsageStatus => ({
	provider: "anthropic", modelKey: MODEL, updatedAt: NOW - 1000,
	hourly: { remainingPercent: 9, resetAt: NOW + 3600_000, windowSeconds: 18000 },
	weekly: { remainingPercent: 54, resetAt: NOW + 7 * 86400_000, windowSeconds: 604800 },
	resetCreditsAvailableCount: 1, resetCredits: [{ title: "Launch credit", expiresAt: NOW + 86400_000 }],
});

describe("Claude Code structured quota telemetry", () => {
	it("keeps a rejection when OAuth reset fractions differ from the CLI's whole seconds", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ status: "rejected", utilization: undefined }), NOW);
		const initial = baseline();
		const endpoint = { ...initial, hourly: { ...initial.hourly!, resetAt: initial.hourly!.resetAt + 743 } };
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW)?.hourly?.remainingPercent, 0);
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW + 1)?.hourly?.remainingPercent, 0);
		cache.observe(sample({ utilization: 0.2, resetsAt: initial.hourly!.resetAt + 743, observedAt: NOW + 1 }), NOW + 1);
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW + 1)?.hourly?.remainingPercent, 0);
	});

	it("does not treat an unused-window placeholder as a newer authoritative reset", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ status: "rejected", utilization: undefined }), NOW);
		const endpoint = anthropicUsageStatusFromResponse({ five_hour: { utilization: 0, resets_at: null } }, MODEL, NOW + 1)!;
		assert.equal(endpoint.hourly?.resetAtEstimated, true);
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW + 1)?.hourly?.remainingPercent, 0);
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW + 1)?.hourly?.resetAt, NOW + 3600_000);
	});

	it("matches a terminal minute-precision reset, then upgrades to structured precision", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ status: "rejected", utilization: undefined, resetPrecision: "minute" }), NOW);
		const initial = baseline();
		const endpoint = { ...initial, hourly: { ...initial.hourly!, resetAt: initial.hourly!.resetAt + 42_743 } };
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW)?.hourly?.remainingPercent, 0);
		cache.observe(sample({ utilization: 0.2, resetsAt: endpoint.hourly.resetAt, observedAt: NOW + 1 }), NOW + 1);
		assert.equal(cache.merge(endpoint, "a", MODEL, NOW + 1)?.hourly?.remainingPercent, 0);
		const newer = { ...endpoint, hourly: { ...endpoint.hourly, resetAt: endpoint.hourly.resetAt + 60_000 } };
		assert.equal(cache.merge(newer, "a", MODEL, NOW + 1), newer);
	});
	it("updates only the observed window and preserves weekly quota and reset credits", () => {
		const cache = new ClaudeCodeRateLimitCache();
		const initial = baseline();
		assert.ok(cache.observe(sample(), NOW));
		const merged = cache.merge(initial, "a", MODEL, NOW)!;
		assert.ok(Math.abs(merged.hourly!.remainingPercent - 7) < 0.001);
		assert.equal(merged.weekly, initial.weekly);
		assert.equal(merged.resetCredits, initial.resetCredits);
		assert.equal(merged.resetCreditsAvailableCount, 1);
		assert.equal(merged.updatedAt, NOW);
		assert.equal(initial.hourly?.remainingPercent, 9, "never mutate endpoint snapshots");
	});

	it("rejected windows stay at zero against lower warnings and older endpoint replies", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ status: "rejected", utilization: undefined }), NOW);
		assert.equal(cache.merge(baseline(), "a", MODEL, NOW)?.hourly?.remainingPercent, 0);
		cache.observe(sample({ utilization: 0.9, observedAt: NOW + 1 }), NOW + 1);
		assert.equal(cache.merge(baseline(), "a", MODEL, NOW + 1)?.hourly?.remainingPercent, 0);
	});

	it("creates a partial snapshot without credentials and never invents the unobserved window", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ rateLimitType: "seven_day", status: "rejected", utilization: undefined }), NOW);
		const merged = cache.merge(undefined, "a", MODEL, NOW)!;
		assert.equal(merged.hourly, undefined);
		assert.equal(merged.weekly?.remainingPercent, 0);
		assert.equal(merged.weekly?.resetAt, NOW + 3600_000);
		assert.equal(merged.weekly?.windowSeconds, 604800);
		assert.equal(merged.resetCredits, undefined);
	});

	it("expires observations, accepts newer reset epochs and ignores out-of-order samples", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample({ utilization: 0.99 }), NOW);
		assert.equal(cache.observe(sample({ observedAt: NOW - 1 }), NOW), undefined);
		const initial = baseline();
		const next = { ...initial, hourly: { ...initial.hourly!, resetAt: NOW + 2 * 3600_000, remainingPercent: 100 } };
		assert.equal(cache.merge(next, "a", MODEL, NOW), next);
		cache.observe(sample(), NOW);
		assert.equal(cache.merge(undefined, "a", MODEL, NOW + 3600_000), undefined);
	});

	it("isolates sessions and model routes and releases forgotten samples", () => {
		const cache = new ClaudeCodeRateLimitCache();
		cache.observe(sample(), NOW);
		assert.equal(cache.merge(undefined, "b", MODEL, NOW), undefined);
		assert.equal(cache.merge(undefined, "a", "pi-claude-code-provider/sonnet", NOW), undefined);
		cache.forget("a");
		assert.equal(cache.merge(undefined, "a", MODEL, NOW), undefined);
	});

	it("rejects unrecognized, expired and malformed telemetry, including warning strings", () => {
		for (const invalid of [
			"Claude rate limit warning: 99% used (five_hour)", null, [],
			sample({ version: 2 }), sample({ sessionId: "" }), sample({ modelRef: "anthropic/opus" }),
			sample({ rateLimitType: "overage" }), sample({ status: "allowed" }),
			sample({ utilization: undefined }), sample({ utilization: 1.1 }), sample({ utilization: Number.NaN }),
			sample({ resetsAt: NOW }), sample({ observedAt: NOW + 1 }),
		]) assert.equal(parseClaudeCodeRateLimitSample(invalid, NOW), undefined);
	});
});
