import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AutoThinkingController, chooseAutoThinkingLevel, closestSupportedThinkingLevel } from "../src/app/thinking/auto-thinking.js";
import type { SubmittedUserMessage, ThinkingLevel } from "../src/app/types.js";

describe("auto thinking", () => {
	it("chooses bounded levels from the current model's available modes", () => {
		assert.equal(chooseAutoThinkingLevel({ promptText: "thanks", availableLevels: ["off", "low", "high"] }).level, "off");
		assert.equal(chooseAutoThinkingLevel({ promptText: "Explain git rebase", availableLevels: ["off", "low", "high"] }).level, "low");
		assert.equal(chooseAutoThinkingLevel({ promptText: "Implement the MVP and add tests for the new flow", availableLevels: ["off", "low", "high"] }).level, "high");
		assert.equal(closestSupportedThinkingLevel("high", ["off", "xhigh"]), "xhigh");
		assert.equal(closestSupportedThinkingLevel("low", ["off", "high"]), "off");
	});

	it("applies prompt decisions transiently and restores the baseline level", () => {
		const session = fakeSession("medium", ["off", "low", "medium", "high"]);
		const controller = new AutoThinkingController();
		controller.enable(session);

		const preparation = controller.prepareForPrompt(session, message("Implement the MVP and add tests for the new flow"));

		assert.equal(preparation?.decision.level, "high");
		assert.equal(session.thinkingLevel, "high");
		assert.equal(controller.label(session), "auto:high");

		preparation?.restore();
		assert.equal(session.thinkingLevel, "medium");
		assert.equal(controller.label(session), "auto:high");
	});
});

function message(promptText: string): SubmittedUserMessage {
	return { id: "m1", promptText, displayText: promptText, images: [] };
}

function fakeSession(initialLevel: ThinkingLevel, availableLevels: ThinkingLevel[]): AgentSession {
	const state = { thinkingLevel: initialLevel };
	return {
		agent: { state },
		get thinkingLevel() { return state.thinkingLevel; },
		get isStreaming() { return false; },
		getAvailableThinkingLevels: () => availableLevels,
	} as unknown as AgentSession;
}
