import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DISABLE_TERMINAL_OUTPUT_BUFFER_ENV,
	TerminalOutputBuffer,
	TERMINAL_OUTPUT_BUFFER_ENV,
	terminalOutputBufferDisabled,
} from "../src/app/terminal/terminal-output-buffer.js";

describe("TerminalOutputBuffer", () => {
	it("diffs frame regions independently", () => {
		const buffer = new TerminalOutputBuffer({ enabled: true });

		assert.equal(buffer.diffFrame({ tabs: "tabs", conversation: "chat", inputStatus: "input" }), "tabschatinput");
		assert.equal(buffer.diffFrame({ tabs: "tabs", conversation: "chat", inputStatus: "input" }), "");
		assert.equal(buffer.diffFrame({ tabs: "tabs", conversation: "chat+scroll", inputStatus: "input" }), "chat+scroll");
		assert.equal(buffer.diffFrame({ tabs: "tabs!", conversation: "chat+scroll", inputStatus: "input!" }), "tabs!input!");
	});

	it("can be disabled for full repaint output", () => {
		const buffer = new TerminalOutputBuffer({ enabled: false });
		const frame = { tabs: "tabs", conversation: "chat", inputStatus: "input" };

		assert.equal(buffer.diffFrame(frame), "tabschatinput");
		assert.equal(buffer.diffFrame(frame), "tabschatinput");
	});
});

describe("terminalOutputBufferDisabled", () => {
	it("uses an explicit disable env var", () => {
		assert.equal(terminalOutputBufferDisabled({}), false);
		assert.equal(terminalOutputBufferDisabled({ [DISABLE_TERMINAL_OUTPUT_BUFFER_ENV]: "1" }), true);
		assert.equal(terminalOutputBufferDisabled({ [DISABLE_TERMINAL_OUTPUT_BUFFER_ENV]: "0" }), false);
		assert.equal(terminalOutputBufferDisabled({ [DISABLE_TERMINAL_OUTPUT_BUFFER_ENV]: "false" }), false);
	});

	it("also accepts a positive feature flag set to false", () => {
		assert.equal(terminalOutputBufferDisabled({ [TERMINAL_OUTPUT_BUFFER_ENV]: "0" }), true);
		assert.equal(terminalOutputBufferDisabled({ [TERMINAL_OUTPUT_BUFFER_ENV]: "off" }), true);
		assert.equal(terminalOutputBufferDisabled({ [TERMINAL_OUTPUT_BUFFER_ENV]: "1" }), false);
	});
});
