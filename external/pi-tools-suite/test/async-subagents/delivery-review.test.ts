import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	filterSubagentConfigForParentModel,
	loadSubagentConfig,
	resolveAgentTaskConfig,
} from "../../src/async-subagents/core/config.js";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import { generatePrompt } from "../../src/async-subagents/core/prompt.js";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-review-agent-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("built-in delivery-review role", () => {
	test("is discoverable with un-gated models, high thinking, least-privilege tools, and packaged guidance", () => {
		const config = loadSubagentConfig(tempDir(), {});
		const role = config.types["delivery-review"];
		expect(role).toBeDefined();
		expect(role.models).toEqual(["openai-codex/gpt-6-sol", "zai/glm-5.3"]);
		expect(role.thinking).toBe("high");
		expect(role.tools).toEqual(["read", "grep", "bash"]);
		expect(role.forParentModels).toBeUndefined();
		expect(role.notForParentModels).toBeUndefined();
		expect(role.promptAppend).toContain("Never probe\nproduction destructively");
		expect(role.promptAppend).toContain("do not assume release authority");
		expect(role.promptAppend).toContain("in-process lock from actual cross-process coordination");
		expect(role.promptAppend).toContain("TOCTOU gaps, lost updates, duplicate execution and idempotency");
		expect(role.promptAppend).toContain("migration compatibility");
		expect(role.promptAppend).toContain("tenant authorization");
		expect(role.promptAppend).toContain("deployment ordering/configuration");
		expect(role.promptAppend).not.toContain(".pi/skills/delivery-review");
	});

	test("survives filtering/catalog for strong parent models and resolves exact model/preset order", () => {
		const config = loadSubagentConfig(tempDir(), {});
		for (const parentModel of ["openai-codex/gpt-6-sol", "zai/glm-5.3", "zai/glm-5-turbo"]) {
			const effective = filterSubagentConfigForParentModel(config, parentModel);
			expect(effective.types["delivery-review"]).toBeDefined();
			expect(buildSubagentCatalogPrompt(config, parentModel)).toContain("- delivery-review:");
		}
		for (const models of [undefined, ["zai/glm-5.3", "openai-codex/gpt-6-sol"]]) {
			const resolved = resolveAgentTaskConfig(
				{ id: "review", task: "Assess residual delivery risk", subagentType: "delivery-review" },
				config,
				{ parentModel: "openai-codex/gpt-6-sol", ...(models ? { preset: { models } } : {}) },
			);
			expect(resolved.task.model).toBe("openai-codex/gpt-6-sol");
			expect(resolved.fallbackModels).toEqual(["zai/glm-5.3"]);
			expect(resolved.task.thinking).toBe("high");
			expect(resolved.task.tools).toEqual(["read", "grep", "bash"]);
		}
		for (const [preset, model] of [["cheap", "zai/glm-5.3"], ["gpt", "openai-codex/gpt-6-sol"], ["deep", "openai-codex/gpt-6-sol"]] as const) {
			const resolved = resolveAgentTaskConfig(
				{ id: "review", task: "Assess residual delivery risk", subagentType: "delivery-review" },
				config,
				{ preset: config.presets![preset] },
			);
			expect(resolved.task.model).toBe(model);
			expect(resolved.task.thinking).toBe("high");
		}
	});

	test("transports the packaged review rules into the generated child prompt", () => {
		const config = loadSubagentConfig(tempDir(), {});
		const resolved = resolveAgentTaskConfig(
			{ id: "review", task: "Review the actual change", subagentType: "delivery-review" }, config,
		);
		const prompt = generatePrompt(resolved.task);
		for (const instruction of [
			"Shell access is for read-only inspection",
			"Do not perform real UI QA",
			"needs attention",
			"distinguish code inspection from runtime verification",
			"Do not recommend release as ready",
			"End with confidence",
			"An unresolved material blocker requires `Low`",
			"does not replace or waive any\nindependent code-review gate",
		]) expect(prompt).toContain(instruction);
	});
});
