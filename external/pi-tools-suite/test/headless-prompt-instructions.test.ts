import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHeadlessToolApi } from "../src/headless/api.js";
import { headlessPromptInstructions } from "../src/headless/prompt-instructions.js";

describe("allowlisted external-host Pix prompt guidance", () => {
	test("exports only todo, AST and subagent strategy; omits Pi lifecycle prompts", () => {
		const sections = headlessPromptInstructions(
			["todo", "ast_grep", "subagents", "dcp", "coding-discipline", "model-tools"],
			"codex",
			{} as NodeJS.ProcessEnv,
		);
		expect(sections.map((section) => section.id)).toEqual(["todo", "ast_grep", "subagents"]);
		const text = sections.map((section) => section.text).join("\n");
		expect(text).toContain("Track/sync non-trivial multi-step work");
		expect(text).toContain("ast_grep");
		expect(text).toContain("cost-aware-orchestrator");
		expect(text).not.toMatch(/\bcoding[- ]discipline\b|\bDCP\b|auto.compress|\/todos\b|<available_subagent_types>|desktop_visual_guidance/i);
		expect(text).not.toContain("pi-tools-suite.jsonc");
		// No project roles, skills, user config, or full Pi SDK prompt are exported.
		expect(text).not.toContain("systemPromptOptions");
	});

	test("omits disabled, read-only, and non-Codex tool policies", () => {
		expect(headlessPromptInstructions(["todo", "ast_grep", "subagents"], "claude")).toEqual([]);
		expect(headlessPromptInstructions([], "codex")).toEqual([]);
		expect(headlessPromptInstructions(["todo", "ast_grep"], "codex").map((s) => s.id))
		.toEqual(["todo", "ast_grep"]);
		expect(headlessPromptInstructions(["subagents"], "codex", { PI_AGENT_STRATEGY: "off" } as NodeJS.ProcessEnv))
		.toEqual([]);
	});

	test("inventory changes with headless read-only mode; no parent Pi hooks execute", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pix-exported-guidance-"));
		try {
			const readOnly = await createHeadlessToolApi({ cwd, readOnly: true });
			const writable = await createHeadlessToolApi({ cwd, readOnly: false });
		expect(readOnly.inventory().instructions.map((section) => section.id)).toEqual(["ast_grep"]);
			expect(writable.inventory().instructions.map((section) => section.id))
				.toEqual(["todo", "ast_grep", "subagents"]);
			expect(writable.inventory().tools.map((tool) => tool.name)).toContain("subagents_catalog");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
