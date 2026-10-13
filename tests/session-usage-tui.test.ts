import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateSessionUsage } from "../src/app/session/session-usage.js";
import { formatTuiSessionUsage, formatTuiSubagentUsage, tuiProviderUsageUrl } from "../src/app/session/session-usage-tui.js";

const usage = { input: 120, output: 30, cacheRead: 100, cacheWrite: 50, totalTokens: 300, cost: { total: 0.123 } };
const runDir = "/workspace/.pi/subagents/example";
const note = JSON.stringify({ version: 1, runDir, agentId: "review" });
const report = aggregateSessionUsage([
	{ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6", usage: { totalTokens: 10, cost: { total: 0.1 } } } },
	{ type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event: "task", runDir, id: "review", task: "Review TUI", subagentType: "verify", model: "requested", scope: "src" } },
	{ type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event: "tool", runDir, id: "review", toolName: "read" } },
	{ type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event: "tool", runDir, id: "review", toolName: "read" } },
	{ type: "usage", kind: "async-subagent", provider: "openai-codex", model: "gpt-6", usage, note },
]);

describe("TUI usage formatting", () => {
	it("keeps parent and child consumption as one session with recorded costs", () => {
		const text = formatTuiSessionUsage(report);
		assert.match(text, /^Session usage\n310 tokens\s+\$0\.22/m);
		assert.match(text, /gpt-6\s+310 \/ \$0\.22/);
		assert.match(text, /Total\s+310 \/ \$0\.22/);
		assert.doesNotMatch(text, /Limits|Subagents.*%|Estimated quota/);
	});

	it("separates account quota and cache state from session spend, never fetching it", () => {
		const quota = {
			provider: "openai" as const, modelKey: "openai-codex/gpt-6", updatedAt: 100,
			hourly: { remainingPercent: 30, resetAt: 60_000, windowSeconds: 3_600 },
			weekly: { remainingPercent: 80, resetAt: 604_800_000, windowSeconds: 604_800 },
			resetCreditsAvailableCount: 2, resetCredits: [{ title: "One extra refresh", count: 2 }],
			stale: true as const,
		};
		const text = formatTuiSessionUsage(report, { quota, now: 0 });
		assert.match(text, /Limits \(account-wide, cached\)/);
		assert.match(text, /Hourly: \[███░░░░░░░\] 30% remaining/);
		assert.match(text, /Weekly: \[████████░░\] 80% remaining/);
		assert.match(text, /Reset credits: 2 available/);
		assert.match(text, /One extra refresh ×2/);
		assert.match(text, /310 tokens\s+\$0\.22/);
	});

	it("matches the subagent detail's task, role, model, tools, exact counters and run identity", () => {
		const child = report.subagents!.agents[0]!;
		const text = formatTuiSubagentUsage(child);
		assert.match(text, /^Subagent: review\nRole: .+ verify/m);
		assert.match(text, /Requested model: requested/);
		assert.match(text, /Recorded models: openai-codex\/gpt-6/);
		assert.match(text, /300 tokens\s+\$0\.12/);
		assert.match(text, /Task\nReview TUI\nScope: src/);
		assert.match(text, /Tool calls: read ×2/);
		assert.match(text, /Input: 120  Output: 30/);
		assert.match(text, /Cache read: 100  Cache write: 50/);
		assert.match(text, /Run: \/workspace\/\.pi\/subagents\/example/);
		assert.doesNotMatch(text, /Status:|changes|unattributed/i);
	});

	it("distinguishes missing usage from zeros and marks estimated per-run cost", () => {
		const noUsage = aggregateSessionUsage([{
			type: "custom", customType: "pi-tools-suite:subagent-statistics",
			data: { version: 1, event: "task", runDir, id: "empty", model: "configured-model" },
		}]).subagents!.agents[0]!;
		const missing = formatTuiSubagentUsage(noUsage);
		assert.match(missing, /Requested model: configured-model/);
		assert.match(missing, /Usage not recorded/);
		assert.doesNotMatch(missing, /Input: 0|Tool calls:/);
		const costEstimated = { ...report.subagents!.agents[0]!, totals: { ...report.subagents!.agents[0]!.totals, costEstimated: true } };
		assert.match(formatTuiSubagentUsage(costEstimated), /~\$0\.12/);
	});

	it("only maps verified provider account usage pages", () => {
		assert.equal(tuiProviderUsageUrl("openai-codex"), "https://chatgpt.com/settings/usage?tab=overview");
		assert.equal(tuiProviderUsageUrl("pi-claude-code-provider"), "https://claude.ai/code#settings/usage");
		assert.equal(tuiProviderUsageUrl("zai"), "https://z.ai/manage-apikey/coding-plan/personal/usage");
		assert.equal(tuiProviderUsageUrl("other"), undefined);
	});
});
