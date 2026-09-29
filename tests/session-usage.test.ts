import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	aggregateSessionUsage,
	formatSessionUsageText,
	loadSessionUsageReport,
} from "../src/app/session/session-usage.js";

describe("session usage accounting", () => {
	it("aggregates direct and subagent calls into the same provider/model totals", () => {
		const report = aggregateSessionUsage([
			{
				type: "message",
				message: {
					role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol",
					usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { total: 0.05 } },
				},
			},
			{
				type: "usage", kind: "async-subagent", provider: "openai-codex", model: "gpt-5.6-sol",
				usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 250, cost: { total: 0.15 } },
			},
			{
				type: "usage", kind: "async-subagent", provider: "openai-codex", model: "gpt-5.6-luna",
				usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { total: 0.02 } },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } },
				},
			},
		]);

		assert.ok(Math.abs(report.totals.cost - 0.23) < 1e-9);
		assert.equal(report.totals.totalTokens, 510);
		assert.deepEqual(report.providers.map((provider) => provider.provider), ["openai-codex"]);
		assert.deepEqual(report.providers[0]?.models.map((model) => model.model), ["gpt-5.6-sol", "gpt-5.6-luna"]);
		assert.equal(report.providers[0]?.models[0]?.totals.totalTokens, 400);
		assert.ok(Math.abs((report.providers[0]?.models[0]?.totals.cost ?? 0) - 0.2) < 1e-9);
		assert.equal(report.providers[0]?.models[1]?.totals.totalTokens, 100);
		assert.equal(report.unattributed.cost, 0.01);
		assert.equal(report.unattributed.totalTokens, 10);
	});

	it("formats a compact token-only provider/model breakdown without quota, prices, or agent labels", () => {
		const report = aggregateSessionUsage([
			{ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage: { totalTokens: 1000, cost: { total: 0.2 } } } },
			{ type: "usage", kind: "async-subagent", provider: "openai-codex", model: "gpt-5.6-sol", usage: { totalTokens: 500, cost: { total: 0.1 } } },
			{ type: "usage", kind: "async-subagent", provider: "anthropic", model: "claude-sonnet", usage: { totalTokens: 300, cost: { total: 0.15 } } },
		]);
		const text = formatSessionUsageText(report, { formatModel: (provider, model) => `<${provider}:${model}>` });
		assert.match(text, /^Session usage\n1\.8K tokens/m);
		assert.match(text, /openai-codex\n\s+<openai-codex:gpt-5\.6-sol>\s+1\.5K/);
		assert.match(text, /anthropic\n\s+<anthropic:claude-sonnet>\s+300/);
		assert.doesNotMatch(text, /\$/);
		assert.doesNotMatch(text, /agents|of session|quota|remaining|used/i);
	});

	it("estimates zero-cost Claude Code subscription usage at original API rates", () => {
		const report = aggregateSessionUsage([
			{
				type: "usage", kind: "async-subagent", provider: "pi-claude-code-provider", model: "opus",
				usage: {
					input: 2, output: 23, cacheRead: 0, cacheWrite: 28_249, totalTokens: 28_274,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);

		assert.equal(report.totals.totalTokens, 28_274);
		assert.ok(Math.abs(report.totals.cost - (2 * 4 + 23 * 20 + 28_249 * 5) / 1_000_000) < 1e-9);
		assert.equal(report.totals.costEstimated, true);
		assert.equal(report.providers[0]?.totals.costEstimated, true);
		assert.equal(report.providers[0]?.models[0]?.totals.costEstimated, true);
		assert.equal(report.providers[0]?.provider, "pi-claude-code-provider");
		assert.equal(report.providers[0]?.models[0]?.model, "opus");
		assert.equal(report.providers[0]?.models[0]?.totals.totalTokens, 28_274);
	});

	it("prices each known alias and explicit original model with all token categories", () => {
		for (const [model, expected] of [
			["opus", 29.2], ["sonnet", 14.7], ["fable", 72.75], ["haiku", 7.35],
			["claude-opus-4-6", 36.75],
		] as const) {
			const report = aggregateSessionUsage([{
				type: "message", message: {
					role: "assistant", provider: "pi-claude-code-provider", model,
					usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
				},
			}]);
			assert.equal(report.totals.cost, expected, model);
			assert.equal(report.totals.totalTokens, 4_000_000);
		}
	});

	it("keeps reported spend, unknown models, other providers, and total-only usage unchanged", () => {
		for (const [provider, model, usage, cost] of [
			["pi-claude-code-provider", "opus", { input: 100, cost: { total: 0.8 } }, 0.8],
			["pi-claude-code-provider", "unknown", { input: 100 }, 0],
			["pi-claude-code-provider", "constructor", { input: 100 }, 0],
			["anthropic", "claude-opus-5-5", { input: 100 }, 0],
			["pi-claude-code-provider", "opus", { totalTokens: 100 }, 0],
		] as const) {
			const report = aggregateSessionUsage([{ type: "usage", provider, model, usage }]);
			assert.equal(report.totals.cost, cost);
			assert.equal(report.totals.costEstimated, undefined);
		}
	});

	it("merges estimated parent and child usage without mutating persisted records", () => {
		const usage = Object.freeze({ input: 1_000_000, cost: Object.freeze({ total: 0 }) });
		const report = aggregateSessionUsage([
			{ type: "message", message: { role: "assistant", provider: "pi-claude-code-provider", model: "opus", usage } },
			{ type: "usage", provider: "pi-claude-code-provider", model: "opus", usage },
			{ type: "usage", provider: "openai", model: "other", usage: { cost: { total: 0.5 } } },
		]);
		assert.equal(report.totals.cost, 8.5);
		assert.equal(report.providers[0]?.models[0]?.totals.cost, 8);
		assert.equal(usage.cost.total, 0);
		assert.equal(report.totals.costEstimated, true);
	});

	it("prices one-hour cache writes separately and clamps invalid counters", () => {
		for (const [cacheWrite1h, expected] of [[500_000, 6.5], [2_000_000, 8], [-1, 5], [NaN, 5]]) {
			const report = aggregateSessionUsage([{
				type: "usage", provider: "pi-claude-code-provider", model: "opus",
				usage: { cacheWrite: 1_000_000, cacheWrite1h },
			}]);
			assert.equal(report.totals.cost, expected);
		}
	});

	it("uses the lazy manager full-session reader instead of the loaded presentation tail", async () => {
		let fullReads = 0;
		const session = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "assistant", provider: "tail", model: "tail", usage: { totalTokens: 1, cost: { total: 0.01 } } } },
				],
				readFullSessionEntries: async () => {
					fullReads += 1;
					return [
						{ type: "message", message: { role: "assistant", provider: "full", model: "model", usage: { totalTokens: 900, cost: { total: 0.9 } } } },
					];
				},
			},
		} as never;

		const report = await loadSessionUsageReport(session);
		assert.equal(fullReads, 1);
		assert.equal(report.totals.totalTokens, 900);
		assert.equal(report.providers[0]?.provider, "full");
		assert.equal(report.providers.some((provider) => provider.provider === "tail"), false);
	});
});
