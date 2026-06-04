import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
	appendAutoThinkingSessionState,
	AutoThinkingController,
	autoThinkingDecisionForDesiredLevel,
	closestSupportedThinkingLevel,
	formatAutoThinkingDecision,
	resolveAutoThinkingSessionState,
} from "../src/app/thinking/auto-thinking.js";
import {
	appendAdaptiveThinkingPrompt,
	buildAdaptiveThinkingSystemPrompt,
	consumeAutoThinkingControlFrameFromAssistantMessage,
	formatAutoThinkingControlFrameLine,
	parseAutoThinkingControlFrameLine,
} from "../src/app/thinking/adaptive-thinking.js";
import type { SubmittedUserMessage, ThinkingLevel } from "../src/app/types.js";

describe("auto thinking", () => {
	it("keeps the current thinking level until the model emits a control frame", async () => {
		const session = fakeSession("medium", ["off", "low", "medium", "high", "xhigh"]);
		const controller = new AutoThinkingController();
		controller.enable(session);

		await controller.prepareForPrompt(session, message("Still failing after two attempts; redesign the migration safely"));

		assert.equal(session.thinkingLevel, "medium");
		assert.equal(controller.label(session), "auto");
	});

	it("uses the medium default when no explicit session thinking level exists", async () => {
		const session = fakeSession(undefined, ["off", "medium", "high"]);
		const controller = new AutoThinkingController();
		controller.enable(session);
		assert.equal(session.thinkingLevel, "medium");

		const decision = controller.applyAdaptiveRequest(session, {
			thinking: "high",
			apply: "next_call",
			reasonCode: "failing_tests",
		});
		assert.equal(decision?.level, "high");
		assert.equal(session.thinkingLevel, "high");

		await controller.prepareForPrompt(session, message("Continue debugging"));
		assert.equal(session.thinkingLevel, "high");

		controller.disable(session);
		assert.equal(session.thinkingLevel, "medium");
	});

	it("maps requested levels to the current model's available modes", () => {
		assert.equal(closestSupportedThinkingLevel("high", ["off", "xhigh"]), "xhigh");
		assert.equal(closestSupportedThinkingLevel("low", ["off", "high"]), "off");
	});

	it("maps explicit adaptive choices to the nearest available level", () => {
		const decision = autoThinkingDecisionForDesiredLevel(
			{ availableLevels: ["off", "medium", "high"] },
			"xhigh",
			"adaptive mode switch: large_migration",
		);

		assert.equal(decision.level, "high");
		assert.equal(decision.desiredLevel, "xhigh");
		assert.equal(decision.reason, "adaptive mode switch: large_migration; nearest available to xhigh");
	});

	it("formats a chat-visible decision summary", () => {
		const decision = autoThinkingDecisionForDesiredLevel(
			{ availableLevels: ["off", "low", "medium", "high"] },
			"high",
			"adaptive mode switch: failing_tests",
		);

		assert.equal(formatAutoThinkingDecision(decision), "auto thinking: high · adaptive mode switch: failing_tests");
	});

	it("parses and strips strict adaptive control frames from assistant messages", () => {
		const line = '<pixctl>{"thinking":"high","apply":"next_call","reasonCode":"failing_tests"}</pixctl>';
		assert.equal(formatAutoThinkingControlFrameLine({
			thinking: "high",
			apply: "next_call",
			reasonCode: "failing_tests",
		}), line);

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

	it("applies adaptive requests as persistent mode switches while auto thinking is enabled", async () => {
		const session = fakeSession("medium", ["off", "low", "medium", "high"]);
		const controller = new AutoThinkingController();
		controller.enable(session);

		await controller.prepareForPrompt(session, message("Continue with the next step"));
		assert.equal(session.thinkingLevel, "medium");

		const decision = controller.applyAdaptiveRequest(session, {
			thinking: "high",
			apply: "next_call",
			reasonCode: "failing_tests",
		});

		assert.equal(decision?.level, "high");
		assert.equal(controller.label(session), "auto:high");
		assert.equal(session.thinkingLevel, "high");

		await controller.prepareForPrompt(session, message("Continue with the next step"));
		assert.equal(controller.label(session), "auto:high");
		assert.equal(session.thinkingLevel, "high");

		assert.equal(controller.applyAdaptiveRequest(session, {
			thinking: "high",
			apply: "next_call",
			reasonCode: "still_debugging",
		}), undefined);
		assert.equal(controller.label(session), "auto:high");
		assert.equal(session.thinkingLevel, "high");

		const followUpDecision = controller.applyAdaptiveRequest(session, {
			thinking: "low",
			apply: "next_call",
			reasonCode: "final_summary",
		});
		assert.equal(followUpDecision?.level, "low");
		assert.equal(controller.label(session), "auto:low");
		assert.equal(session.thinkingLevel, "low");

		await controller.prepareForPrompt(session, message("Summarize the result"));
		assert.equal(controller.label(session), "auto:low");
		assert.equal(session.thinkingLevel, "low");

		const mediumDecision = controller.applyAdaptiveRequest(session, {
			thinking: "medium",
			apply: "next_call",
			reasonCode: "ordinary_development",
		});
		assert.equal(mediumDecision?.level, "medium");
		assert.equal(controller.label(session), "auto:medium");
		assert.equal(session.thinkingLevel, "medium");
	});

	it("adds adaptive thinking instructions only once", () => {
		const prompt = appendAdaptiveThinkingPrompt("Base prompt");
		assert.match(prompt, /Pix adaptive thinking is enabled/u);
		assert.equal(appendAdaptiveThinkingPrompt(prompt), prompt);
	});

	it("lists the active model's supported levels in the adaptive prompt", () => {
		const prompt = buildAdaptiveThinkingSystemPrompt(["off", "low", "high"], "low");

		assert.match(prompt, /Active model supported thinking levels: off\|low\|high\./u);
		assert.match(prompt, /Default thinking level: medium\./u);
		assert.match(prompt, /Current auto-thinking mode: low\./u);
		assert.match(prompt, /Pix does not classify prompts/u);
		assert.match(prompt, /Without a control frame, future calls keep the current mode/u);
		assert.match(prompt, /change the persistent mode for later calls/u);
		assert.match(prompt, /when current is unset, Pix uses medium/u);
		assert.match(prompt, /Choose one supported level/u);
		assert.match(prompt, /Use high\/xhigh for hard debugging/u);
		assert.match(prompt, /Lower again when the cause is known/u);
		assert.doesNotMatch(prompt, /Active model supported thinking levels: off\|minimal\|low\|medium\|high\|xhigh\./u);
	});

	it("uses medium as the current level fallback in the adaptive prompt", () => {
		const prompt = buildAdaptiveThinkingSystemPrompt(["off", "medium", "high"]);

		assert.match(prompt, /Current auto-thinking mode: medium\./u);
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

function fakeSession(initialLevel: ThinkingLevel | undefined, availableLevels: ThinkingLevel[]): AgentSession {
	const state: { thinkingLevel?: ThinkingLevel } = { thinkingLevel: initialLevel };
	return {
		agent: { state },
		get thinkingLevel() { return state.thinkingLevel; },
		get isStreaming() { return false; },
		getAvailableThinkingLevels: () => availableLevels,
	} as unknown as AgentSession;
}
