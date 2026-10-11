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
	test("ships as an economical docs-only role without an IDX prerequisite", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		expect(role.models).toEqual(["openai-codex/gpt-6-luna", "zai/glm-5.3-flash"]);
		expect(role.thinking).toBe("low");
		expect(role.tools).toEqual(["read", "grep", "bash", "edit", "write"]);
		expect(role.timeoutMs).toBe(1_200_000);
		const prompt = generatePrompt({
			id: "docs", task: "Update documentation for the final changes",
			subagentType: "knowledge-auditor", model: role.models![0], promptAppend: role.promptAppend,
		}).replace(/\s+/g, " ");
		expect(prompt).toContain("Run before the parent finishes an implementation task");
		expect(prompt).toContain("small, unambiguous documentation-only repairs");
		expect(prompt).toContain("Return substantial or ambiguous discrepancies to the parent as ESCALATE");
		expect(prompt).toContain("Do not recursively read every declared Implementation/Tests dependency");
		expect(prompt).toContain("Do not run index refreshes or review-receipt commands");
		expect(prompt).toContain("No global cleanliness verdict or dependency-coverage ledger is required");
		expect(prompt).toContain("No external indexing service is required");
		expect(prompt).not.toContain("global knowledge dirty: yes | no | unknown");
	});

	test("keeps explicit document reviews bounded and preserves editing boundaries", () => {
		const role = loadSubagentConfig(tempDir(), {}).types["knowledge-auditor"];
		const prompt = role.promptAppend!.replace(/\s+/g, " ");
		expect(prompt).toContain("explicitly requested **spec-review**");
		expect(prompt).toContain("changed product paths are not required");
		expect(prompt).toContain("Never modify product/source code, tests, configuration, lockfiles");
		expect(prompt).toContain("target project's `.pi/artifacts/`");
		expect(prompt).toContain("unassigned document already has local edits");
		expect(prompt).toContain("Never invent motives from code");
		expect(prompt).toContain("Do not create/accept/supersede decisions yourself");
		expect(prompt).toContain("A justified no-record handoff is valid");
		expect(prompt).toContain("A missing qualifying decision record requires ESCALATE");
		expect(prompt).toContain("`escalate`, never `create`");
	});

	for (const indexed of [false, true]) test(`is routable and requests final documentation maintenance (indexed=${indexed})`, async () => {
		const cwd = tempDir();
		if (indexed) fs.mkdirSync(path.join(cwd, ".indexer-cli"));
		const config = loadSubagentConfig(cwd, {});
		expect(filterSubagentConfigForContext(config, { cwd }).types["knowledge-auditor"]).toBeDefined();
		const catalog = buildSubagentCatalogPrompt(config, undefined, cwd)!;
		expect(catalog).toContain("- knowledge-auditor:");
		expect(catalog).toContain("Before completing an implementation task, run `knowledge-auditor`");
		expect(catalog).toContain("No knowledge dirty checks, acknowledgment or exhaustive dependency review is required");
		const routed = await routeSubagentTasks([
			{ id: "docs", task: "Update affected documentation", subagentType: "knowledge-auditor" },
		], config, { cwd });
		expect(routed.usedLlm).toBe(false);
		expect(routed.tasks[0]?.subagentType).toBe("knowledge-auditor");
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

	test("rejects the retired indexed-project visibility flag", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "indexed-only.md"), `---
description: Indexed-only helper.
models: [zai/glm-5.3-flash]
requiresIndexedProject: true
---
Indexed only.
`);
		expect(() => loadSubagentConfig(cwd, {})).toThrow(/Unknown agent frontmatter key "requiresIndexedProject"/);

		writeFile(path.join(cwd, ".pi", "agents", "indexed-only.md"), `---
description: Invalid indexed-only helper.
models: [zai/glm-5.3-flash]
requiresIndexedProject: yes
---
Invalid.
`);
		expect(() => loadSubagentConfig(cwd, {})).toThrow(/Unknown agent frontmatter key "requiresIndexedProject"/);
	});
});
