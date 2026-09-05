import { describe, expect, test } from "bun:test";

import { evaluateAssertions } from "./harness/assertions.js";
import { deriveMetrics } from "./harness/metrics.js";
import { renderEvalReportMarkdown } from "./harness/report.js";
import type { EvalCase, EvalEvent, EvalReport } from "./harness/types.js";

describe("eval harness", () => {
	test("derives mutation and behavioral verification metrics from tool events", () => {
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: true },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_result", toolName: "apply_patch", isError: false },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: false },
			{ type: "agent_end", usage: { input: 80, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 105, cost: 0.01 } },
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1234, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		expect(metrics.toolCallCount).toBe(3);
		expect(metrics.mutationCount).toBe(1);
		expect(metrics.verificationCount).toBe(2);
		expect(metrics.failedToolResults).toBe(1);
		expect(metrics.changedFiles).toEqual(["src/a.ts"]);
		expect(metrics.parentUsage.totalTokens).toBe(105);
		expect(metrics.parentUsage.cost).toBe(0.01);
	});

	test("enforces reproduce-before-edit and verify-after-edit workflow assertions", () => {
		const evalCase: EvalCase = {
			id: "workflow",
			category: "coding-quality",
			description: "workflow",
			fixture: "demo",
			prompt: "workflow",
			assert: { requireReproBeforeMutation: true, requireVerificationAfterMutation: true },
		};
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		const assertions = evaluateAssertions(evalCase, {
			caseId: evalCase.id,
			model: "test/model",
			projectDir: "/missing",
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			events,
			metrics,
		});
		expect(assertions.filter((item) => !item.passed)).toEqual([]);
	});

	test("renders comparable model/token/cost report", () => {
		const report: EvalReport = {
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:01.000Z",
			models: ["zai/glm-5.3"],
			results: [{
				caseId: "case",
				model: "zai/glm-5.3",
				projectDir: "/tmp/case",
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				events: [],
				metrics: {
					elapsedMs: 1000,
					toolCallCount: 2,
					toolCalls: ["repo_search", "read"],
					failedToolResults: 0,
					mutationCount: 0,
					verificationCount: 0,
					changedFiles: [],
					parentUsage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: 0.01 },
					subagentUsage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: 0.002 },
					subagentCount: 1,
				},
				assertions: [],
				passed: true,
			}],
		};
		const markdown = renderEvalReportMarkdown(report);
		expect(markdown).toContain("zai/glm-5.3");
		expect(markdown).toContain("100");
		expect(markdown).toContain("50");
		expect(markdown).toContain("$0.0120");
	});
});
