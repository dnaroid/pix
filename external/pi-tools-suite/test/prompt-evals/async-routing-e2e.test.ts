import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig, routeSubagentTasks, type SubagentConfig } from "../../src/async-subagents/lib.js";
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
	const config = loadSubagentConfig(process.cwd(), {});
	return {
		...config,
		routing: {
			enabled: true,
			model: E2E_MODEL,
			fallbackModels: [],
			maxTaskChars: 1200,
			maxTokens: 512,
			maxRetries: 0,
			timeoutMs: 60_000,
		},
	};
}

describe("async-subagents direct live prompt evals", () => {
	e2eTest("routes an omitted type to a project-local Markdown specialist alongside built-in roles", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-routing-eval-"));
		try {
			const dir = path.join(cwd, ".pi", "agents");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "house-review.md"), `---
description: Review changes specifically against this project's house rules and repository conventions, not a general security audit.
thinking: high
---

Apply the project's house checklist before approving changes.
`);
			const cfg = loadSubagentConfig(cwd, {});
			cfg.routing = routingConfig().routing;
			const result = await withE2ERetry("project-local fallback router", async () => {
				const live = await createLiveModelContext(E2E_MODEL);
				return routeSubagentTasks([
					{ id: "project-check", task: "Review this project's diff specifically against its house rules and repository conventions." },
					{ id: "explicit", task: "Keep the parent's explicit choice.", subagentType: "research" },
				], cfg, { model: live.model, modelRegistry: live.modelRegistry });
			});
			expect(result.usedLlm).toBe(true);
			expect(result.routes).toEqual({ "project-check": "house-review" });
			expect(result.tasks.map((task) => task.subagentType)).toEqual(["house-review", "research"]);
			expect(result.warnings).toEqual([]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, E2E_TIMEOUT_MS);

	e2eTest("routes omitted subagent types from task semantics while preserving explicit overrides", async () => {
		const result = await withE2ERetry("direct subagent router", async () => {
			const live = await createLiveModelContext(E2E_MODEL);
			return routeSubagentTasks([
				{ id: "known-file", task: "Read package.json and report the package version only.", scope: "package.json" },
				{ id: "repo-sweep", task: "Search the entire repository and inventory every authentication entrypoint and related test file." },
				{ id: "security-review", task: "Perform an independent security and correctness review of the payment flow; return prioritized findings." },
				{ id: "race-root-cause", task: "Read retry, persistence, and observability code and collect evidence for root-cause hypotheses. Do not edit or execute tests; the parent will decide the fix." },
				{ id: "write-docs", task: "Update the API documentation and examples for the already specified pagination contract. Make the required file changes." },
				{ id: "test-run", task: "Run the targeted payment tests, inspect their failure logs, and report pass/fail without changing any files." },
				{ id: "browser-check", task: "Verify Add to cart in the real browser with screenshots, video, trace and deterministic assertions." },
				{ id: "explicit-override", task: "Give the requested independent strong second opinion.", subagentType: "oracle" },
			], routingConfig(), {
				model: live.model,
				modelRegistry: live.modelRegistry,
			});
		});

		expect(result.usedLlm).toBe(true);
		expect(result.routes).toEqual({
			"known-file": "research",
			"repo-sweep": "research",
			"security-review": "research",
			"race-root-cause": "research",
			"write-docs": "implement",
			"test-run": "verify",
			"browser-check": "browser-qa",
		});
		expect(result.tasks.find((task) => task.id === "explicit-override")?.subagentType).toBe("oracle");
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
