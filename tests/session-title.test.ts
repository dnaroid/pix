import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildForkTitleInput, fallbackSessionTitleFromInput, firstUserMessageText } from "../extensions/session-title/index.js";

describe("session-title extension", () => {
	it("finds text from the first existing user message", () => {
		const ctx = fakeContext([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "  Fix flaky title generation  " }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Second request" }] } },
		]);

		assert.equal(firstUserMessageText(ctx), "Fix flaky title generation");
	});

	it("joins text blocks and ignores non-text content", () => {
		const ctx = fakeContext([
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", data: "..." },
						{ type: "text", text: "Analyze screenshot" },
						{ type: "text", text: "and fix UI state" },
					],
				},
			},
		]);

		assert.equal(firstUserMessageText(ctx), "Analyze screenshot\nand fix UI state");
	});

	it("supports legacy string message content", () => {
		const ctx = fakeContext([
			{ type: "message", message: { role: "user", content: "  Rename this session  " } },
		]);

		assert.equal(firstUserMessageText(ctx), "Rename this session");
	});

	it("builds fork title input from the parent title and fork prompt", () => {
		assert.equal(
			buildForkTitleInput("Implement Session Titles", "  Make fork names use the new prompt  "),
			[
				"Parent session title:",
				"Implement Session Titles",
				"",
				"First prompt in this fork:",
				"Make fork names use the new prompt",
			].join("\n"),
		);
	});

	it("falls back to the fork prompt when the parent title is unavailable", () => {
		assert.equal(buildForkTitleInput(undefined, "  Investigate crash  "), "Investigate crash");
	});

	it("builds a local fallback title from the first user words", () => {
		assert.equal(
			fallbackSessionTitleFromInput("  fix delayed session title refresh after model timeout in rust tui  ", 80),
			"fix delayed session title refresh after model timeout",
		);
	});

	it("truncates the fallback title to the configured character limit", () => {
		assert.equal(
			fallbackSessionTitleFromInput("Investigate intermittent title model outage and add a safer local fallback", 24),
			"Investigate intermittent",
		);
	});

	it("ignores leading punctuation in fallback titles", () => {
		assert.equal(
			fallbackSessionTitleFromInput("  --- \"\" Fix broken title retries now please  ", 80),
			"Fix broken title retries now please",
		);
	});
});

function fakeContext(branch: unknown[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}
