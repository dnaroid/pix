import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTerminalEditShortcutSequence, parseTerminalInterruptSequence, terminalEditShortcutForControlChar } from "../src/app/input/terminal-edit-shortcuts.js";

describe("terminal edit shortcut parsing", () => {
	it("parses Cmd+Z from Kitty CSI-u with and without event types", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[122;9u"), {
			kind: "shortcut",
			shortcut: "undo",
			length: "\x1b[122;9u".length,
		});

		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[122;9:1u"), {
			kind: "shortcut",
			shortcut: "undo",
			length: "\x1b[122;9:1u".length,
		});
	});

	it("parses Cmd+Shift+Z and Cmd+Y as redo", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[122;10:1u"), {
			kind: "shortcut",
			shortcut: "redo",
			length: "\x1b[122;10:1u".length,
		});
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[90;10:1u"), {
			kind: "shortcut",
			shortcut: "redo",
			length: "\x1b[90;10:1u".length,
		});
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[121;9:1u"), {
			kind: "shortcut",
			shortcut: "redo",
			length: "\x1b[121;9:1u".length,
		});
	});

	it("uses Kitty base layout keys for non-Latin layouts", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[1103::122;9:1u"), {
			kind: "shortcut",
			shortcut: "undo",
			length: "\x1b[1103::122;9:1u".length,
		});
	});

	it("swallows Kitty key release events", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[122;9:3u"), {
			kind: "ignore",
			length: "\x1b[122;9:3u".length,
		});
	});

	it("parses xterm modifyOtherKeys Cmd shortcuts", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[27;9;122~"), {
			kind: "shortcut",
			shortcut: "undo",
			length: "\x1b[27;9;122~".length,
		});
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[27;10;90~"), {
			kind: "shortcut",
			shortcut: "redo",
			length: "\x1b[27;10;90~".length,
		});
	});

	it("returns pending for split edit shortcut sequences", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[122;9:"), { kind: "pending" });
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[27;9;"), { kind: "pending" });
	});

	it("leaves unrelated sequences for other handlers", () => {
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[13;2u"), { kind: "none" });
		assert.deepEqual(parseTerminalEditShortcutSequence("\x1b[118;5u"), { kind: "none" });
	});

	it("maps raw control undo and redo fallbacks", () => {
		assert.equal(terminalEditShortcutForControlChar("\u001a", false), "undo");
		assert.equal(terminalEditShortcutForControlChar("\u001a", true), "redo");
		assert.equal(terminalEditShortcutForControlChar("\u0019", false), "redo");
		assert.equal(terminalEditShortcutForControlChar("z", false), undefined);
	});

	it("parses terminal Ctrl+C interrupt sequences", () => {
		assert.deepEqual(parseTerminalInterruptSequence("\x1b[99;5u"), {
			kind: "interrupt",
			length: "\x1b[99;5u".length,
		});
		assert.deepEqual(parseTerminalInterruptSequence("\x1b[27;5;99~"), {
			kind: "interrupt",
			length: "\x1b[27;5;99~".length,
		});
		assert.deepEqual(parseTerminalInterruptSequence("\x1b[27;5;1089~"), {
			kind: "interrupt",
			length: "\x1b[27;5;1089~".length,
		});
	});

	it("returns pending for split Ctrl+C interrupt sequences", () => {
		assert.deepEqual(parseTerminalInterruptSequence("\x1b[99;"), { kind: "pending" });
		assert.deepEqual(parseTerminalInterruptSequence("\x1b[27;5;"), { kind: "pending" });
	});
});
