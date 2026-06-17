import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DISABLE_TERMINAL_OUTPUT_BUFFER_ENV,
	TerminalOutputBuffer,
	TERMINAL_OUTPUT_BUFFER_ENV,
	terminalOutputBufferDisabled,
} from "../src/app/terminal/terminal-output-buffer.js";

const row = (value: number, output: string) => ({ row: value, output });

describe("TerminalOutputBuffer", () => {
	it("diffs frame rows independently", () => {
		const buffer = new TerminalOutputBuffer({ enabled: true });

		assert.equal(buffer.diffFrame([row(1, "tabs"), row(3, "chat"), row(5, "input")]), "tabschatinput");
		assert.equal(buffer.diffFrame([row(1, "tabs"), row(3, "chat"), row(5, "input")]), "");
		assert.equal(buffer.diffFrame([row(1, "tabs"), row(3, "chat+scroll"), row(5, "input")]), "chat+scroll");
		assert.equal(buffer.diffFrame([row(1, "tabs!"), row(3, "chat+scroll"), row(5, "input!")]), "tabs!input!");
	});

	it("clears rows that disappear between frames", () => {
		const buffer = new TerminalOutputBuffer({ enabled: true });

		buffer.diffFrame([row(3, "chat"), row(4, "chat2")]);
		const cleared = buffer.diffFrame([row(3, "chat")]);

		assert.match(cleared, /\x1b\[4;1H/);
		assert.match(cleared, /\x1b\[2K/);
	});

	it("can be disabled for full repaint output", () => {
		const buffer = new TerminalOutputBuffer({ enabled: false });
		const frame = [row(1, "tabs"), row(3, "chat"), row(5, "input")];

		assert.equal(buffer.diffFrame(frame), "tabschatinput");
		assert.equal(buffer.diffFrame(frame), "tabschatinput");
	});

	it("diffs status line separately and resets together", () => {
		const buffer = new TerminalOutputBuffer({ enabled: true });

		assert.equal(buffer.diff("statusLine", "status"), "status");
		assert.equal(buffer.diff("statusLine", "status"), "");
		assert.equal(buffer.diff("statusLine", "status2"), "status2");
		buffer.reset();
		assert.equal(buffer.diff("statusLine", "status"), "status");
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
