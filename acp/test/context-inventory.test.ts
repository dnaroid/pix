import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatReloadContextInventory,
	isSkillFileAccessTool,
	parseContextInventoryState,
	withFinalSkillCommands,
} from "../src/acp/context-inventory.js";

describe("Desktop context inventory formatting", () => {
	it("parses loaded context paths without duplicates and preserves them across skill refresh", () => {
		const state = parseContextInventoryState({
			version: 1, tools: ["read"], skills: [],
			contextFiles: [" /parent/AGENTS.md ", "/project/AGENTS.override.md", "/parent/AGENTS.md"],
		});
		assert.deepEqual(state?.contextFiles, ["/parent/AGENTS.md", "/project/AGENTS.override.md"]);
		assert.deepEqual(withFinalSkillCommands(state, [])?.contextFiles, state?.contextFiles);
		assert.equal(parseContextInventoryState({ version: 1, tools: [], skills: [], contextFiles: [42] }), undefined);
	});

	it("distinguishes unavailable legacy inventory from an empty loaded file list", () => {
		assert.match(formatReloadContextInventory({ version: 1, tools: [], skills: [] }), /Context files \(in context\): \(inventory unavailable\)/u);
		assert.match(formatReloadContextInventory({ version: 1, tools: [], skills: [], contextFiles: [] }), /Context files \(in context\): \(none\)/u);
	});

	it("renders context paths literally even when Markdown characters occur", () => {
		const text = formatReloadContextInventory({
			version: 1, tools: [], skills: [], contextFiles: ["/my_project/[notes]/AGENTS.md"],
		});
		assert.ok(text.includes("- /my\\_project/\\[notes\\]/AGENTS\\.md"));
	});

	it("escapes underscores in Markdown-rendered tool, skill, and agent identifiers", () => {
		const text = formatReloadContextInventory({
			version: 1,
			model: "zai/glm-5.3",
			thinking: "high",
			skills: ["repo_knowledge"],
			tools: ["repo_architecture", "session_read_section"],
			agents: ["test_runner"],
		});

		assert.match(text, /Skills \(in context\): repo\\_knowledge/u);
		assert.match(text, /Tools \(active\): repo\\_architecture, session\\_read\\_section/u);
		assert.match(text, /Agents \(available\): test\\_runner/u);
	});

	it("keeps final skill commands for all supported case-insensitive file-access tools", () => {
		for (const tool of ["read", "Read", "BASH", "shell", "SHELL_COMMAND"]) {
			assert.equal(isSkillFileAccessTool(tool), true, tool);
			const state = withFinalSkillCommands({
				version: 1,
				tools: [tool],
				skills: [],
			}, [{ name: "skill:visible", source: "skill" }]);
			assert.deepEqual(state?.skills, ["visible"]);
		}
		assert.equal(isSkillFileAccessTool("powershell"), false);
	});
});
