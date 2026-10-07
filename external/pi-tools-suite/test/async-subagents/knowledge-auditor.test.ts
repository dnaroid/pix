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
		expect(decisionGuidance).toContain("Default to no new record unless explicitly requested by the user");
		expect(decisionGuidance).toContain("costly reversal AND has durable rationale");
		expect(decisionGuidance).toContain("changed spec alone is not a trigger");
		expect(decisionGuidance).toContain("A justified no-record handoff is valid");
		expect(decisionGuidance).toContain("Missing rationale is an escalation only for qualifying choices");
		expect(decisionGuidance).toContain("do not demand a record merely because behavior changed");
		expect(decisionGuidance).toContain("Do not prune or rewrite historical records");
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

	test("retries knowledge lock contention in both modes without bypassing locks", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const prompt = generatePrompt({
			id: "lock-audit",
			task: "Audit the final knowledge drift",
			subagentType: "knowledge-auditor",
			model: role.models![0],
			promptAppend: role.promptAppend,
		}).replace(/\s+/g, " ");
		expect(prompt).toContain("Knowledge lock contention (both modes)");
		expect(prompt).toContain("another agent in a parallel session may be writing");
		expect(prompt).toContain("Wait 5 seconds and retry the same command");
		expect(prompt).toContain("at most 60 seconds per blocked operation");
		expect(prompt).toContain("Stop retrying as soon as the command succeeds");
		expect(prompt).toContain("even if it exits 0; retry it within the same budget");
		expect(prompt).toContain("Retry only explicit lock contention, not unrelated command errors");
		expect(prompt).toContain("Never delete or force-release another session's lock");
		expect(prompt).toContain("kill its owner, or bypass locking");
		expect(prompt).toContain("return a blocker with the command, lock diagnostic, elapsed waiting time and last exit code");
		expect(prompt).toContain("recheck reviewed specs/dependencies for concurrent changes before acknowledgment");
		expect(prompt).toContain("Spec-review mode still must not acknowledge specs independently");
	});

	test("escalates a missing qualifying record even when the parent supplied rationale", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const prompt = role.promptAppend!.replace(/\s+/g, " ");
		expect(prompt).toContain("a missing decision record requires ESCALATE even when the parent supplied complete rationale");
		expect(prompt).toContain("Supplied rationale or a proposed record path is not an existing record");
		expect(prompt).toContain("your audit outcome is `escalate`, never `create`");
		expect(prompt).toContain("A justified no-record handoff is valid");
	});

	test("supports explicit bounded spec-review without weakening default task audit", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const task = "Use spec-review mode for specs/example.md; review current dependencies in one pass.";
		const generated = generatePrompt({
			id: "spec-slice",
			task,
			subagentType: "knowledge-auditor",
			model: role.models![0],
			promptAppend: role.promptAppend,
		}).replace(/\s+/g, " ");
		expect(role.description).toContain("explicit spec-review slices");
		expect(generated).toContain(task);
		expect(generated).toContain("Default to **task-audit**");
		expect(generated).toContain("Use **spec-review** only when the parent explicitly requests that mode");
		expect(generated).toContain("explicit list of project-relative spec paths and the review goal");
		expect(generated).toContain("Changed product paths are not required in this mode");
		expect(generated).toContain("every declared Implementation/Tests dependency against current content");
		expect(generated).toContain("If the inputs required by the selected mode are missing, return a blocker");
		expect(generated).toContain("Never run `idx knowledge acknowledge` in this mode, even for unchanged specs");
		expect(generated).toContain("Respect the parent's pass/time budget");
		expect(generated).toContain("do not run a global cleanup loop");
		expect(generated).toContain("spec review: passed | blocked");
		expect(generated).toContain("For eligible specs, run `idx knowledge acknowledge <spec-paths...>`");
	});

	test("permits disposable review evidence but not product edits or invented coverage", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const prompt = role.promptAppend!.replace(/\s+/g, " ");
		expect(prompt).toContain("Never modify product/source code, tests, configuration, lockfiles, generated files");
		expect(prompt).toContain("except disposable reports/logs in unique run/task directories under the target project's `.pi/artifacts/`");
		expect(prompt).toContain("Never use root `artifacts/` or `.artifacts/`");
		expect(prompt).toContain("Return the evidence inline if no report path was requested");
		expect(prompt).toContain("report the gap; do not pretend coverage");
		expect(prompt).toContain("concurrent changes to reviewed specs/dependencies as invalidated coverage");
		expect(role.tools).toEqual(["read", "grep", "bash", "edit", "write"]);
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
