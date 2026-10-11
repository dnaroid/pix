import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContextInventoryState, isSkillFileAccessTool } from "../src/context-inventory.js";

const dirs: string[] = [];
const previousHome = process.env.HOME;

beforeEach(() => {
	process.env.HOME = tempDir();
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("context inventory", () => {
	test("uses skill provenance and effective project role metadata", () => {
		const cwd = tempDir();
		fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "agents", "research.md"), "---\nname: research\ndescription: Local research\n---\nProject instructions\n");
		fs.writeFileSync(path.join(cwd, ".pi", "agents", "hidden.md"), "---\nname: hidden\nforParentModels: [\"other/*\"]\n---\nHidden\n");
		const state = createContextInventoryState({
			getActiveTools: () => ["read", "subagents"],
			getCommands: () => [
				{ name: "skill:global", source: "skill", sourceInfo: { scope: "user" } },
				{ name: "skill:local", source: "skill", sourceInfo: { scope: "project" } },
			] as any,
		} as any, context(cwd, "openai-codex", "gpt-6-luna"));
		expect(state.projectSkills).toEqual(["local"]);
		expect(state.projectAgents).toEqual(["research"]);
		expect(state.agents).not.toContain("hidden");
	});
	test("reports final active tools, skills readable in context, and parent-model-gated agents", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["project_search", "read", "subagents", "read"],
			getCommands: () => [
				{ name: "skill:frontier-model-rollover", source: "skill" },
				{ name: "reload", source: "extension" },
				{ name: "skill:project-agent-creator", source: "skill" },
			] as any,
		} as any, context(cwd, "openai-codex", "gpt-6-luna"), "reload");

		expect(state.reason).toBe("reload");
		expect(state.tools).toEqual(["project_search", "read", "subagents"]);
		expect(state.skills).toEqual(["frontier-model-rollover", "project-agent-creator"]);
		expect(state.agents).toContain("oracle");
		expect(state.model).toBe("openai-codex/gpt-6-luna");
	});

	test("exposes merged oracle for a frontier parent", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["read", "subagents"],
			getCommands: () => [] as any,
		} as any, context(cwd, "openai-codex", "gpt-6-astra"));

		expect(state.agents).toContain("oracle");
		expect(state.agents).toContain("research");
	});

	test("recognizes model-specific and shell skill-file tools case-insensitively", () => {
		for (const tool of ["read", "Read", "BASH", "shell", "SHELL_COMMAND"]) {
			expect(isSkillFileAccessTool(tool)).toBe(true);
		}
		expect(isSkillFileAccessTool("powershell")).toBe(false);

		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["SHELL_COMMAND"],
			getCommands: () => [{ name: "skill:visible", source: "skill" }] as any,
		} as any, context(cwd, "openai-codex", "gpt-6-luna"));

		expect(state.skills).toEqual(["visible"]);
	});

	test("does not claim loaded skills or agents when their access tools are inactive", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["project_search", "apply_patch"],
			getCommands: () => [{ name: "skill:hidden", source: "skill" }] as any,
		} as any, context(cwd, "openai-codex", "gpt-6-luna"));

		expect(state.skills).toEqual([]);
		expect(state.agents).toEqual([]);
	});
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-test-"));
	dirs.push(dir);
	return dir;
}

function context(cwd: string, provider: string, id: string): any {
	return {
		cwd,
		model: { provider, id },
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => path.join(cwd, "session.jsonl"),
		},
	};
}
