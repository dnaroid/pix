import { describe, expect, test } from "bun:test";
import { routeSubagentTasks, type SubagentConfig } from "../../src/async-subagents/lib.js";
import { decideUltraworkAuto } from "../../src/async-subagents/core/ultrawork-auto.js";
import { withE2ERetry } from "../e2e-retry.js";
import { createLiveModelContext, resolveLiveModelRef } from "../support/live-model.js";

const RUN_E2E = /^(1|true|yes)$/i.test(
	process.env.ASYNC_SUBAGENTS_ROUTING_E2E ?? process.env.PROMPT_EVAL_E2E ?? "",
);
const E2E_MODEL = resolveLiveModelRef("ASYNC_SUBAGENTS_ROUTING_E2E_MODEL", "ASYNC_SUBAGENTS_MODEL");
const E2E_TIMEOUT_MS = Number(process.env.ASYNC_SUBAGENTS_ROUTING_E2E_TIMEOUT_MS ?? 180_000);
const e2eTest = RUN_E2E ? test : test.skip;

function routingConfig(): SubagentConfig {
	return {
		defaultType: "deep",
		routing: {
			enabled: true,
			model: E2E_MODEL,
			fallbackModels: [],
			maxTaskChars: 1200,
			maxTokens: 512,
			maxRetries: 0,
			timeoutMs: 60_000,
		},
		types: {
			quick: { description: "Tiny cheap lookup in one known file or verification of one simple fact; never a repo-wide search." },
			scan: { description: "Repository-wide file and symbol discovery or broad search sweep; locate code, do not review its quality." },
			review: { description: "Independent code quality, security, correctness, or maintainability review with prioritized findings." },
			deep: { description: "Hard cross-module root-cause debugging, architecture reasoning, or broad change-impact analysis." },
			frontend: { description: "UI/UX implementation, responsive layout, accessibility, or visual frontend polish." },
		},
	};
}

describe("async-subagents direct live prompt evals", () => {
	e2eTest("routes omitted subagent types from task semantics while preserving explicit overrides", async () => {
		const result = await withE2ERetry("direct subagent router", async () => {
			const live = await createLiveModelContext(E2E_MODEL);
			return routeSubagentTasks([
				{ id: "known-file", task: "Read package.json and report the package version only.", scope: "package.json" },
				{ id: "repo-sweep", task: "Search the entire repository and inventory every authentication entrypoint and related test file." },
				{ id: "security-review", task: "Perform an independent security and correctness review of the payment flow; return prioritized findings." },
				{ id: "race-root-cause", task: "Develop and test cross-module root-cause hypotheses for an intermittent checkout race involving retries, persistence, and observability." },
				{ id: "explicit-override", task: "Keep this deterministic override unchanged.", subagentType: "quick" },
			], routingConfig(), {
				model: live.model,
				modelRegistry: live.modelRegistry,
			});
		});

		expect(result.usedLlm).toBe(true);
		expect(result.routes).toEqual({
			"known-file": "quick",
			"repo-sweep": "scan",
			"security-review": "review",
			"race-root-cause": "deep",
		});
		expect(result.tasks.find((task) => task.id === "explicit-override")?.subagentType).toBe("quick");
		expect(result.routes["explicit-override"]).toBeUndefined();
	}, E2E_TIMEOUT_MS);

	for (const scenario of [
		{
			name: "clearly parallel release review",
			prompt: "Assess this repository for release readiness now. Split architecture, security, test strategy, and rollout risks into independent parallel review tracks and combine the evidence.",
			expected: "ultrawork" as const,
		},
		{
			name: "vague potentially complex bug",
			prompt: "Fix this bug.",
			expected: "hint" as const,
		},
		{
			name: "known one-file wording edit",
			prompt: "In README.md replace the exact text 'old label' with 'new label'. This is a one-file wording edit.",
			expected: "none" as const,
		},
	]) {
		e2eTest(`classifies ultrawork boundary: ${scenario.name}`, async () => {
			const decision = await withE2ERetry(`ultrawork classifier: ${scenario.name}`, async () => {
				const live = await createLiveModelContext(E2E_MODEL);
				return decideUltraworkAuto(scenario.prompt, routingConfig(), {
					model: live.model,
					modelRegistry: live.modelRegistry,
				});
			});
			expect(decision).toBe(scenario.expected);
		}, E2E_TIMEOUT_MS);
	}
});
