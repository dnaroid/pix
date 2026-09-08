import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import {
	createReloadContextInventory,
	formatReloadContextInventory,
} from "../src/app/commands/reload-context-inventory.js";
import { parseSubagentCatalogState } from "../src/app/extensions/subagent-catalog-state.js";

describe("reload context inventory", () => {
	it("reports only skills that can actually be injected plus active tools and model-gated agents", () => {
		const runtime = fakeRuntime({
			tools: ["repo_search", "read", "subagents", "read"],
			skills: ["project-agent-creator", "frontier-model-rollover", "project-agent-creator"],
			model: { provider: "openai-codex", id: "gpt-5.6-luna" },
			thinkingLevel: "high",
		});

		const inventory = createReloadContextInventory(runtime, ["research", "frontier-review", "research"]);

		assert.deepEqual(inventory.tools, ["repo_search", "read", "subagents"]);
		assert.deepEqual(inventory.skills, ["frontier-model-rollover", "project-agent-creator"]);
		assert.deepEqual(inventory.agents, ["frontier-review", "research"]);
		assert.equal(inventory.model, "openai-codex/gpt-5.6-luna:high");
		assert.match(formatReloadContextInventory(inventory), /Skills \(in context\): frontier-model-rollover, project-agent-creator/);
		assert.match(formatReloadContextInventory(inventory), /Agents \(available\): frontier-review, research/);
	});

	it("does not claim skills or agents are in context when their access tools are inactive", () => {
		const inventory = createReloadContextInventory(fakeRuntime({
			tools: ["repo_search", "apply_patch"],
			skills: ["frontier-model-rollover"],
			model: { provider: "openai-codex", id: "gpt-5.6-sol" },
			thinkingLevel: "off",
		}), ["research"]);

		assert.deepEqual(inventory.skills, []);
		assert.deepEqual(inventory.agents, []);
		const text = formatReloadContextInventory(inventory);
		assert.match(text, /Skills \(in context\): \(none; read\/bash inactive\)/);
		assert.match(text, /Agents \(available\): \(none; subagents tool inactive\)/);
	});

	it("distinguishes a missing agent catalog from an empty available catalog", () => {
		const inventory = createReloadContextInventory(fakeRuntime({
			tools: ["read", "subagents"],
			skills: [],
			model: { provider: "zai", id: "glm-5-turbo" },
			thinkingLevel: "off",
		}), undefined);

		assert.equal(inventory.agents, undefined);
		assert.match(formatReloadContextInventory(inventory), /Agents \(available\): \(catalog unavailable\)/);
	});
});

describe("subagent catalog state", () => {
	it("parses the effective role event and removes duplicate names", () => {
		assert.deepEqual(parseSubagentCatalogState({
			version: 1,
			sessionId: "session-1",
			model: "openai-codex/gpt-5.6-luna",
			types: ["research", "frontier-review", "research"],
		}), {
			version: 1,
			sessionId: "session-1",
			model: "openai-codex/gpt-5.6-luna",
			types: ["research", "frontier-review"],
		});
	});

	it("rejects malformed role events", () => {
		assert.equal(parseSubagentCatalogState({ version: 1, types: ["research", 1] }), undefined);
		assert.equal(parseSubagentCatalogState({ version: 2, types: ["research"] }), undefined);
	});
});

function fakeRuntime(options: {
	tools: string[];
	skills: string[];
	model: { provider: string; id: string };
	thinkingLevel: string;
}): AgentSessionRuntime {
	return ({
		session: {
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			getActiveToolNames: () => options.tools,
			resourceLoader: {
				getSkills: () => ({ skills: options.skills.map((name) => ({ name })) }),
			},
		},
	} as unknown) as AgentSessionRuntime;
}
