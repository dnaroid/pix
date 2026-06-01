import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppInputController, type InputControllerHost } from "../src/app/input-controller.js";
import { InputEditor } from "../src/input-editor.js";

describe("AppInputController extension editor input", () => {
	it("inserts a newline for raw Shift+Enter before a focused extension can submit it", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: true });

		controller.handleChunk(Buffer.from("\r"));

		assert.equal(editor.text, "\n");
		assert.equal(calls.extensionInput, 0);
		assert.equal(calls.enter, 0);
		assert.equal(calls.render, 1);
	});

	it("keeps raw Enter routed to the focused extension when Shift is not pressed", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: false });

		controller.handleChunk(Buffer.from("\r"));

		assert.equal(editor.text, "");
		assert.equal(calls.extensionInput, 1);
		assert.equal(calls.enter, 0);
	});
});

describe("AppInputController terminal input", () => {
	it("treats xterm modifyOtherKeys Ctrl+C as interrupt instead of inserting sequence text", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("\x1b[27;5;1089~"));

		assert.equal(editor.text, "");
		assert.equal(calls.interrupt, 1);
	});
});

function createController(options: { extensionInputUsesEditor: boolean; shiftPressed: boolean; consumeExtensionInput?: boolean }): {
	controller: AppInputController;
	editor: InputEditor;
	calls: { extensionInput: number; enter: number; interrupt: number; render: number };
} {
	const editor = new InputEditor();
	const calls = { extensionInput: 0, enter: 0, interrupt: 0, render: 0 };
	const host: InputControllerHost = {
		inputEditor: editor,
		cwd: process.cwd(),
		handleExtensionTerminalInput: () => {
			calls.extensionInput += 1;
			return { consume: options.consumeExtensionInput ?? true };
		},
		extensionInputUsesEditor: () => options.extensionInputUsesEditor,
		isShiftPressed: () => options.shiftPressed,
		getInput: () => editor.text,
		getDirectPopupMenu: () => undefined,
		resetRequestHistoryNavigation: () => undefined,
		resetInputMenuDismissals: () => undefined,
		render: () => {
			calls.render += 1;
		},
		moveActivePopupMenuSelection: () => false,
		navigateRequestHistory: () => false,
		scrollByLines: () => undefined,
		scrollByPage: () => undefined,
		handleMouse: () => undefined,
		handleEnter: () => {
			calls.enter += 1;
		},
		handleInterrupt: async () => {
			calls.interrupt += 1;
		},
		handleEscape: async () => undefined,
		handleDirectPopupInput: () => false,
		autocompleteModel: () => false,
		autocompleteThinking: () => false,
		autocompleteSlashCommand: () => undefined,
		toggleVoiceRecording: () => undefined,
		stop: async () => undefined,
	};

	return { controller: new AppInputController(host), editor, calls };
}
