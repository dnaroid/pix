import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContextInventoryState } from "../src/context-inventory.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("context inventory", () => {
	test("reports final active tools, skills readable in context, and parent-model-gated agents", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["repo_search", "read", "subagents", "read"],
			getCommands: () => [
				{ name: "skill:frontier-model-rollover", source: "skill" },
				{ name: "reload", source: "extension" },
				{ name: "skill:project-agent-creator", source: "skill" },
			] as any,
		} as any, context(cwd, "openai-codex", "gpt-5.6-luna"), "reload");

		expect(state.reason).toBe("reload");
		expect(state.tools).toEqual(["repo_search", "read", "subagents"]);
		expect(state.skills).toEqual(["frontier-model-rollover", "project-agent-creator"]);
		expect(state.agents).toContain("frontier-review");
		expect(state.model).toBe("openai-codex/gpt-5.6-luna");
	});

	test("hides frontier-review for a frontier parent", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["read", "subagents"],
			getCommands: () => [] as any,
		} as any, context(cwd, "openai-codex", "gpt-5.6-sol"));

		expect(state.agents).not.toContain("frontier-review");
		expect(state.agents).toContain("research");
	});

	test("does not claim loaded skills or agents when their access tools are inactive", () => {
		const cwd = tempDir();
		const state = createContextInventoryState({
			getActiveTools: () => ["repo_search", "apply_patch"],
			getCommands: () => [{ name: "skill:hidden", source: "skill" }] as any,
		} as any, context(cwd, "openai-codex", "gpt-5.6-luna"));

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
