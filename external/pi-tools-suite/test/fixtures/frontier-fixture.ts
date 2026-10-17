import type { FrontierModelEntry } from "../../src/async-subagents/core/frontier-models.js";

/** Test-only frontier roster. Production code ships no model ids; the setup wizard writes the user's own. */
export const TEST_FRONTIER_MODELS: readonly FrontierModelEntry[] = Object.freeze([
	{ model: "openai-codex/gpt-6-astra", expensive: true, aliases: ["*gpt*astra*"], roles: ["oracle"] },
	{ model: "zai/glm-5.3" },
	{ model: "anthropic/claude-opus-5-5", expensive: true, aliases: ["*opus*"] },
]);

export function testFrontierConfig() {
	return { models: TEST_FRONTIER_MODELS.map((entry) => ({ ...entry, ...(entry.aliases ? { aliases: [...entry.aliases] } : {}), ...(entry.roles ? { roles: [...entry.roles] } : {}) })), economy: false };
}
