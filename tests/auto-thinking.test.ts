import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
	appendAutoThinkingSessionState,
	AutoThinkingController,
	autoThinkingDecisionForDesiredLevel,
	chooseAutoThinkingLevel,
	closestSupportedThinkingLevel,
	formatAutoThinkingDecision,
	resolveAutoThinkingSessionState,
} from "../src/app/thinking/auto-thinking.js";
import {
	appendAdaptiveThinkingPrompt,
	buildAdaptiveThinkingSystemPrompt,
	consumeAutoThinkingControlFrameFromAssistantMessage,
	parseAutoThinkingControlFrameLine,
} from "../src/app/thinking/adaptive-thinking.js";
import type { SubmittedUserMessage, ThinkingLevel } from "../src/app/types.js";

describe("auto thinking", () => {
	it("starts from a bounded medium baseline for the current model's available modes", () => {
		assert.equal(chooseAutoThinkingLevel({ promptText: "thanks", availableLevels: ["off", "low", "medium", "high"] }).level, "medium");
		assert.equal(chooseAutoThinkingLevel({ promptText: "Implement the MVP and add tests for the new flow", availableLevels: ["off", "low", "high"] }).level, "low");
		assert.equal(chooseAutoThinkingLevel({ promptText: "Explain git rebase", availableLevels: ["off"] }).level, "off");
		assert.equal(closestSupportedThinkingLevel("high", ["off", "xhigh"]), "xhigh");
		assert.equal(closestSupportedThinkingLevel("low", ["off", "high"]), "off");
	});

	it("applies prompt decisions transiently and restores the baseline level", async () => {
		const session = fakeSession("medium", ["off", "low", "medium", "high"]);
		const controller = new AutoThinkingController();
		controller.enable(session);

		const preparation = await controller.prepareForPrompt(session, message("Implement the MVP and add tests for the new flow"));

		assert.equal(preparation?.decision.level, "medium");
		assert.equal(session.thinkingLevel, "medium");
		assert.equal(controller.label(session), "auto:medium");

		preparation?.restore();
		assert.equal(session.thinkingLevel, "medium");
		assert.equal(controller.label(session), "auto:medium");
	});

	it("maps explicit adaptive choices to the nearest available level", () => {
		const decision = autoThinkingDecisionForDesiredLevel(
			{ promptText: "Migrate the renderer and add coverage", availableLevels: ["off", "medium", "high"] },
			"xhigh",
			"adaptive next call: large_migration",
		);

		assert.equal(decision.level, "high");
		assert.equal(decision.desiredLevel, "xhigh");
		assert.equal(decision.reason, "adaptive next call: large_migration; nearest available to xhigh");
	});

	it("formats a chat-visible decision summary", () => {
		const decision = chooseAutoThinkingLevel({
			promptText: "Implement the MVP and add tests for the new flow",
			availableLevels: ["off", "low", "medium", "high"],
		});

		assert.equal(formatAutoThinkingDecision(decision), "auto thinking: medium · default medium baseline");
	});

	it("parses and strips strict adaptive control frames from assistant messages", () => {
		const line = '<pixctl>{"thinking":"high","apply":"next_call","reasonCode":"failing_tests"}</pixctl>';
		assert.deepEqual(parseAutoThinkingControlFrameLine(line), {
			thinking: "high",
			apply: "next_call",
			reasonCode: "failing_tests",
		});

		const consumed = consumeAutoThinkingControlFrameFromAssistantMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: `\n${line}\nVisible answer` },
			],
		});

		assert.equal(consumed?.control.thinking, "high");
		assert.deepEqual(consumed?.message, {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "Visible answer" },
			],
		});
	});

	it("applies adaptive requests transiently while auto thinking is enabled", async () => {
		const session = fakeSession("medium", ["off", "low", "medium", "high"]);
		const controller = new AutoThinkingController();
		controller.enable(session);

		const preparation = await controller.prepareForPrompt(session, message("Continue with the next step"));
		assert.equal(session.thinkingLevel, "medium");

		const decision = controller.applyAdaptiveRequest(session, {
			thinking: "high",
			apply: "next_call",
			reasonCode: "failing_tests",
		});

		assert.equal(decision?.level, "high");
		assert.equal(controller.label(session), "auto:high");
		assert.equal(session.thinkingLevel, "high");

		preparation?.restore();
		assert.equal(session.thinkingLevel, "medium");
	});

	it("adds adaptive thinking instructions only once", () => {
		const prompt = appendAdaptiveThinkingPrompt("Base prompt");
		assert.match(prompt, /Pix adaptive thinking is enabled/u);
		assert.equal(appendAdaptiveThinkingPrompt(prompt), prompt);
	});

	it("lists the active model's supported levels in the adaptive prompt", () => {
		const prompt = buildAdaptiveThinkingSystemPrompt(["off", "low", "high"]);

		assert.match(prompt, /Active model supported thinking levels: off\|low\|high\./u);
		assert.match(prompt, /Choose only one of the active model supported thinking levels/u);
		assert.doesNotMatch(prompt, /Active model supported thinking levels: off\|minimal\|low\|medium\|high\|xhigh\./u);
	});

	it("persists and resolves the latest auto thinking session state", () => {
		const entries: unknown[] = [];
		const session = {
			sessionManager: {
				appendCustomEntry: (customType: string, data: unknown) => {
					entries.push({ type: "custom", id: String(entries.length), parentId: null, timestamp: "2026-06-04T00:00:00.000Z", customType, data });
				},
			},
		} as AgentSession;

		appendAutoThinkingSessionState(session, true);
		assert.equal(resolveAutoThinkingSessionState(entries as never), true);

		appendAutoThinkingSessionState(session, false);
		assert.equal(resolveAutoThinkingSessionState(entries as never), false);
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
