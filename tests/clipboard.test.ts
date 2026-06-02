import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { osc52ClipboardSequence } from "../src/app/screen/clipboard.js";

describe("clipboard OSC52 fallback", () => {
	it("formats a plain OSC52 clipboard sequence", () => {
		assert.equal(osc52ClipboardSequence("hello", {}), "\x1b]52;c;aGVsbG8=\x07");
	});

	it("wraps OSC52 for tmux passthrough", () => {
		assert.equal(osc52ClipboardSequence("hello", { TMUX: "/tmp/tmux" }), "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\");
	});

	it("wraps OSC52 for screen passthrough", () => {
		assert.equal(osc52ClipboardSequence("hello", { STY: "screen" }), "\x1bP\x1b]52;c;aGVsbG8=\x07\x1b\\");
	});
});
