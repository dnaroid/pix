import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import {
	filterSubagentConfigForContext,
	loadSubagentConfig,
} from "../../src/async-subagents/core/config.js";
import { generatePrompt } from "../../src/async-subagents/core/prompt.js";
import { routeSubagentTasks } from "../../src/async-subagents/core/routing.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-auditor-agent-"));
	tempDirs.push(dir);
	return dir;
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("built-in knowledge-auditor role", () => {
	test("ships as an economical docs-only role with indexed-project visibility", () => {
		const cwd = tempDir();
		const config = loadSubagentConfig(cwd, {});
		const role = config.types["knowledge-auditor"];

		expect(role).toBeDefined();
		expect(role.requiresIndexedProject).toBe(true);
		expect(role.models).toEqual(["openai-codex/gpt-6-luna", "zai/glm-5.3-flash"]);
		expect(role.thinking).toBe("low");
		expect(role.tools).toEqual(["read", "grep", "bash", "edit", "write"]);
		expect(role.timeoutMs).toBe(300_000);
		expect(role.promptAppend).toContain("Run `idx audit`");
		expect(role.promptAppend).toContain("ESCALATE");
		const decisionGuidance = role.promptAppend!.replace(/\s+/g, " ");
		expect(decisionGuidance).toContain("Missing rationale is an escalation");
		expect(decisionGuidance).toContain("reciprocal spec links, evidence versus assumptions");
		expect(decisionGuidance).toContain("Never invent motives from code");
		expect(decisionGuidance).toContain("Do not create/accept/supersede decisions yourself");
		expect(decisionGuidance).toContain("Trivial edits do not need a decision record");
		expect(decisionGuidance).toContain("uncovered dependencies as an ESCALATE");
		expect(decisionGuidance).toContain("every declared Implementation/ Tests dependency");
		expect(decisionGuidance).toContain("never all specs merely to clear");
		expect(generatePrompt({
			id: "audit",
			task: "Audit the final knowledge drift",
			subagentType: "knowledge-auditor",
			model: role.models![0],
			promptAppend: role.promptAppend,
		})).toContain("small, unambiguous drift");
	});

	test("is hidden without .indexer-cli and becomes available from the project marker alone", async () => {
		const cwd = tempDir();
		const config = loadSubagentConfig(cwd, {});

		expect(config.types["knowledge-auditor"]).toBeDefined();
		expect(filterSubagentConfigForContext(config, { cwd }).types["knowledge-auditor"]).toBeUndefined();
		expect(buildSubagentCatalogPrompt(config, undefined, cwd)).not.toContain("- knowledge-auditor:");
		await expect(routeSubagentTasks([
			{ id: "audit", task: "Run the final knowledge audit", subagentType: "knowledge-auditor" },
		], config, { cwd })).rejects.toThrow(/subagentType unavailable for parent model \(unknown\) or project context/);

		fs.mkdirSync(path.join(cwd, ".indexer-cli"));

		expect(filterSubagentConfigForContext(config, { cwd }).types["knowledge-auditor"]).toBeDefined();
		const catalog = buildSubagentCatalogPrompt(config, undefined, cwd)!;
		expect(catalog).toContain("- knowledge-auditor:");
		expect(catalog).toContain("Before finalizing, obtain its result");
		expect(catalog).toContain("Later edits to reviewed specs/dependencies require re-review");
		expect(catalog).toContain("global knowledge dirty=yes alone must not keep it open");
		expect(catalog).toContain("never acknowledge unrelated specs");
		expect(catalog).toContain("spawning alone is not completion");
		const routed = await routeSubagentTasks([
			{ id: "audit", task: "Run the final knowledge audit", subagentType: "knowledge-auditor" },
		], config, { cwd });
		expect(routed.usedLlm).toBe(false);
		expect(routed.tasks[0]?.subagentType).toBe("knowledge-auditor");
	});

	test("separates task completion from parallel agents' global dirtiness without weakening review", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const prompt = role.promptAppend!.replace(/\s+/g, " ");
		expect(prompt).toContain("task audit: passed | blocked");
		expect(prompt).toContain("global knowledge dirty: yes | no | unknown");
		expect(prompt).toContain("global knowledge dirty=yes alone must not keep it open");
		expect(prompt).toContain("cause of a remaining global `yes` is unknown, say unclassified");
		expect(prompt).toContain("not proof that the remaining dirtiness is unrelated");
		expect(prompt).toContain("failed/incomplete check is unknown, never clean");
		expect(prompt).toContain("Unrelated concurrent edits do not require waiting or re-review");
		expect(prompt).toContain("concurrent edits to reviewed specs/dependencies remain blockers");
		expect(prompt).toContain("required dependency coverage is complete");
		expect(prompt).toContain("Never call the entire knowledge base clean based on task-scoped success");
		expect(prompt).toContain("never all specs merely to clear");
	});

	test("a same-name project role completely replaces the built-in role and announces the replacement", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "knowledge-auditor.md"), `---
description: Project-specific knowledge audit wording.
models: [zai/glm-5.3-flash]
thinking: medium
---
Keep the project-specific audit convention too.
`);

		const config = loadSubagentConfig(cwd, {});
		const role = config.types["knowledge-auditor"];
		expect(role.description).toBe("Project-specific knowledge audit wording.");
		expect(role.models).toEqual(["zai/glm-5.3-flash"]);
		expect(role.thinking).toBe("medium");
		expect(role.requiresIndexedProject).toBeUndefined();
		expect(role.tools).toBeUndefined();
		expect(filterSubagentConfigForContext(config, { cwd }).types["knowledge-auditor"]).toBeDefined();
		expect(config.projectAgentMetadata?.["knowledge-auditor"]).toEqual({
			sourceName: "knowledge-auditor",
			replacesBuiltin: true,
		});
		const catalog = buildSubagentCatalogPrompt(config, undefined, cwd)!;
		expect(catalog).toContain("Project-local agent definitions replace same-named built-ins completely.");
		expect(catalog).toContain("Active project replacements of built-ins: knowledge-auditor.");
		expect(catalog).toContain("- knowledge-auditor: Project-specific knowledge audit wording.");
	});

	test("accepts the generic visibility flag only as a boolean", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "indexed-only.md"), `---
description: Indexed-only helper.
models: [zai/glm-5.3-flash]
requiresIndexedProject: true
---
Indexed only.
`);
		const valid = loadSubagentConfig(cwd, {});
		expect(valid.types["indexed-only"]?.requiresIndexedProject).toBe(true);
		expect(filterSubagentConfigForContext(valid, { cwd }).types["indexed-only"]).toBeUndefined();

		writeFile(path.join(cwd, ".pi", "agents", "indexed-only.md"), `---
description: Invalid indexed-only helper.
models: [zai/glm-5.3-flash]
requiresIndexedProject: yes
---
Invalid.
`);
		expect(() => loadSubagentConfig(cwd, {})).toThrow(/requiresIndexedProject must be a boolean/);
	});
});
