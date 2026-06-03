import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isThinkingLevel, parseModelRef, parseScopedModelRef, stripProviderFromModelRef } from "../src/app/model/model-ref.js";

describe("model refs", () => {
	it("parses provider/model refs with optional thinking suffix", () => {
		assert.deepEqual(parseModelRef("zai/glm-5-turbo"), { provider: "zai", modelId: "glm-5-turbo" });
		assert.deepEqual(parseModelRef("openai-codex/gpt-5.5:high"), { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" });
	});

	it("rejects empty, unscoped, and unknown-thinking model refs", () => {
		assert.throws(() => parseModelRef(""), /cannot be empty/u);
		assert.throws(() => parseModelRef("model-only"), /provider\/model/u);
		assert.throws(() => parseModelRef("provider/"), /provider\/model/u);
		assert.throws(() => parseModelRef("provider/model:turbo"), /Unknown thinking level/u);
	});

	it("parses scoped refs without treating non-thinking colons as suffixes", () => {
		assert.deepEqual(parseScopedModelRef("provider/model:v1"), { provider: "provider", modelId: "model:v1" });
		assert.deepEqual(parseScopedModelRef("provider/model:low"), { provider: "provider", modelId: "model", thinkingLevel: "low" });
		assert.equal(parseScopedModelRef("provider/"), undefined);
		assert.equal(parseScopedModelRef("model"), undefined);
	});

	it("recognizes supported thinking levels and strips providers", () => {
		assert.equal(isThinkingLevel("minimal"), true);
		assert.equal(isThinkingLevel("turbo"), false);
		assert.equal(stripProviderFromModelRef("zai/glm-5-turbo"), "glm-5-turbo");
		assert.equal(stripProviderFromModelRef("plain-model"), "plain-model");
		assert.equal(stripProviderFromModelRef("provider/"), "provider/");
	});
});
