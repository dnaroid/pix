import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { resolvePixRuntimeInitialThinkingLevel, resolvePixRuntimeModelRef, resolveSessionModelRefFromTail } from "../src/app/runtime.js";
import type { PixConfig } from "../src/config.js";

const configWithDefault = {
	defaultModel: { modelRef: "openai-codex/gpt-5.5", thinking: "medium" },
} as PixConfig;

describe("runtime model defaults", () => {
	it("uses the pix default model only for sessions without existing entries", () => {
		assert.equal(resolvePixRuntimeModelRef({}, fakeSessionManager(0), configWithDefault), "openai-codex/gpt-5.5:medium");
		assert.equal(resolvePixRuntimeModelRef({}, fakeSessionManager(1), configWithDefault), "zai/glm-5-turbo:low");
	});

	it("keeps an explicit runtime model override even when resuming a session", () => {
		assert.equal(resolvePixRuntimeModelRef({ modelRef: "zai/glm-5-turbo:low" }, fakeSessionManager(1), configWithDefault), "zai/glm-5-turbo:low");
	});

	it("resolves initial thinking only from explicit or resumed model refs", () => {
		assert.equal(resolvePixRuntimeInitialThinkingLevel({}, fakeSessionManager(0), configWithDefault), "medium");
		assert.equal(resolvePixRuntimeInitialThinkingLevel({ modelRef: "zai/glm-5-turbo:low" }, fakeSessionManager(0), configWithDefault), "low");
		assert.equal(resolvePixRuntimeInitialThinkingLevel({}, fakeSessionManager(1), configWithDefault), "low");
	});

	it("scans resumed session state from the tail so later model and thinking changes win", () => {
		assert.equal(resolveSessionModelRefFromTail([
			modelChange("zai", "glm-5-turbo"),
			thinkingChange("low"),
			modelChange("openai-codex", "gpt-5.5"),
			thinkingChange("high"),
		]), "openai-codex/gpt-5.5:high");
	});
});

function fakeSessionManager(entryCount: number) {
	const entries = entryCount > 0
		? [modelChange("zai", "glm-5-turbo"), thinkingChange("low")]
		: [];
	return {
		getEntries: (): SessionEntry[] => entries,
		getBranch: (): SessionEntry[] => entries,
	};
}

function modelChange(provider: string, modelId: string): SessionEntry {
	return {
		type: "model_change",
		id: `model-${provider}-${modelId}`,
		parentId: null,
		timestamp: "2026-06-03T00:00:00.000Z",
		provider,
		modelId,
	};
}

function thinkingChange(thinkingLevel: string): SessionEntry {
	return {
		type: "thinking_level_change",
		id: `thinking-${thinkingLevel}`,
		parentId: null,
		timestamp: "2026-06-03T00:00:00.000Z",
		thinkingLevel,
	};
}
