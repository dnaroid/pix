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
