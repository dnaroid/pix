import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateSessionUsage } from "../src/app/session/session-usage.js";

function telemetry(event: string, runDir: string, id: string, data: Record<string, unknown> = {}) {
	return { type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event, runDir, id, ...data } };
}
function child(runDir: string | undefined, id: string | undefined, tokens = 10, cost = 0.1, model = "first") {
	return {
		type: "usage", kind: "async-subagent", provider: "test", model,
		usage: { input: tokens - 2, output: 2, totalTokens: tokens, cost: { total: cost } },
		note: runDir ? JSON.stringify({ version: 1, runDir, agentId: id }) : id ? `agent:${id}` : undefined,
	};
}

describe("session subagent statistics", () => {
	it("groups by run + id, counts tool starts, and keeps task/icon/type and terminal state", () => {
		const report = aggregateSessionUsage([
			telemetry("task", "/run/one", "review", { task: "Review changes", icon: "Search", subagentType: "research", model: "requested", scope: "src" }),
			telemetry("tool", "/run/one", "review", { toolName: "read" }),
			telemetry("tool", "/run/one", "review", { toolName: "read" }),
			child("/run/one", "review"),
			child("/run/one", "review", 20, 0.2, "fallback"),
			telemetry("state", "/run/one", "review", { status: "done" }),
			telemetry("task", "/run/two", "review", { task: "Another review" }),
			child("/run/two", "review", 40, 0.4),
		]);
		const stats = report.subagents!;
		assert.equal(stats.agents.length, 2);
		const first = stats.agents[0]!;
		assert.equal(first.task, "Review changes");
		assert.equal(first.icon, "Search");
		assert.equal(first.subagentType, "research");
		assert.equal(first.configuredModel, "requested");
		assert.equal(first.scope, "src");
		assert.equal(first.status, "done");
		assert.deepEqual(first.tools, [{ name: "read", count: 2 }]);
		assert.equal(first.totals.totalTokens, 30);
		assert.equal(first.usageRecorded, true);
		assert.deepEqual(first.models.map((row) => row.model), ["first", "fallback"]);
		assert.notEqual(first.key, stats.agents[1]!.key);
		assert.equal(stats.totals.totalTokens, 70);
		assert.equal(report.totals.totalTokens, 70, "detail must not double-count child usage");
	});
	it("separates main, subagents, and other side usage with additive conservation", () => {
		const report = aggregateSessionUsage([
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 1 } } } },
			{ type: "compaction", usage: { totalTokens: 4, cost: { total: 0.04 } } },
			{ type: "message", message: { role: "toolResult", usage: { totalTokens: 3, cost: { total: 0.03 } } } },
			...(["heads-up", "btw"].map((kind) => ({ type: "usage", kind, usage: { totalTokens: 5, cost: { total: 0.05 } } }))),
			child("/one", "test", 300, 3),
		]);
		const stats = report.subagents!;
		assert.equal(stats.main.totalTokens, 107);
		assert.equal(stats.other.totalTokens, 10);
		assert.equal(stats.totals.totalTokens, 300);
		assert.equal(stats.main.totalTokens + stats.other.totalTokens + stats.totals.totalTokens, report.totals.totalTokens);
		assert.ok(Math.abs(stats.main.cost + stats.other.cost + stats.totals.cost - report.totals.cost) < 1e-9);
	});
	it("matches old agent notes only to a unique spawn run and never invents tool history", () => {
		const report = aggregateSessionUsage([
			child(undefined, "worker"),
			{ type: "message", message: { role: "toolResult", toolName: "subagents", details: {
				mode: "spawn", runDir: "/legacy", tasks: [{ id: "worker", task: "A legacy task", subagentType: "verify" }], agents: [{ id: "worker", status: "done" }],
			} } },
		]);
		assert.equal(report.subagents!.agents.length, 1);
		assert.equal(report.subagents!.agents[0]!.task, "A legacy task");
		assert.equal(report.subagents!.agents[0]!.runDir, "/legacy");
		assert.equal(report.subagents!.agents[0]!.tools, undefined);
		assert.equal(report.subagents!.unattributed.totalTokens, 0);
	});
	it("keeps ambiguous or malformed historical usage in child-unattributed totals", () => {
		const malformed = { ...child(undefined, "x"), note: "{bad note" };
		const report = aggregateSessionUsage([
			telemetry("task", "/one", "x"), telemetry("task", "/two", "x"),
			child(undefined, "x"), malformed, child(undefined, undefined),
		]);
		assert.equal(report.subagents!.totals.totalTokens, 30);
		assert.equal(report.subagents!.unattributed.totalTokens, 30);
		assert.ok(report.subagents!.agents.every((agent) => agent.usageRecorded === false));
	});
	it("resolves structured identities before legacy notes even without task metadata", () => {
		const report = aggregateSessionUsage([child(undefined, "x"), child("/one", "x"), child("/two", "x")]);
		assert.equal(report.subagents!.agents.length, 2);
		assert.equal(report.subagents!.unattributed.totalTokens, 10);
		assert.ok(report.subagents!.agents.every((agent) => agent.totals.totalTokens === 10));
	});
	it("distinguishes absent billing from a recorded zero and absent tools from none", () => {
		const stats = aggregateSessionUsage([
			telemetry("task", "/one", "waiting"), telemetry("state", "/one", "waiting", { status: "stopped" }),
			child("/two", "zero", 0, 0), child(undefined, "old"),
		]).subagents!;
		const waiting = stats.agents.find((agent) => agent.agentId === "waiting")!;
		assert.equal(waiting.usageRecorded, false);
		assert.equal(waiting.status, "stopped");
		assert.deepEqual(waiting.tools, []);
		assert.equal(stats.agents.find((agent) => agent.agentId === "zero")!.usageRecorded, true);
		assert.equal(stats.agents.find((agent) => agent.agentId === "old")!.tools, undefined);
	});
	it("propagates pricing estimates into child/model totals without mutating records", () => {
		const call = { ...child("/one", "x"), provider: "pi-claude-code-provider", model: "opus", usage: { input: 1_000, output: 100, cost: { total: 0 } } };
		const before = structuredClone(call);
		const report = aggregateSessionUsage([call]);
		assert.equal(report.subagents!.totals.costEstimated, true);
		assert.equal(report.subagents!.agents[0]!.totals.costEstimated, true);
		assert.equal(report.subagents!.agents[0]!.models[0]!.totals.costEstimated, true);
		assert.deepEqual(call, before);
	});
	it("never attributes status lookups for unrelated runs to this session", () => {
		const stats = aggregateSessionUsage([{ type: "message", message: { role: "toolResult", toolName: "subagents", details: {
			mode: "status", runDir: "/other-session", tasks: [{ id: "foreign" }], agents: [{ id: "foreign", status: "done" }],
		} } }]).subagents!;
		assert.deepEqual(stats.agents, []);
	});
});
