import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatReloadContextInventory } from "../src/acp/context-inventory.js";

describe("Desktop context inventory formatting", () => {
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
});
