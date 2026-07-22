import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppInputController, type InputControllerHost } from "../src/app/input/input-controller.js";
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

	it("inserts a newline for iTerm2-style Shift+Enter sequences before a focused extension can submit them", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: false });

		controller.handleChunk(Buffer.from("\x1b[13;2u"));

		assert.equal(editor.text, "\n");
		assert.equal(calls.extensionInput, 0);
		assert.equal(calls.enter, 0);
		assert.equal(calls.render, 1);
	});

	it("inserts a newline for Kitty Shift+Enter press events before a focused extension can submit them", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: false });

		controller.handleChunk(Buffer.from("\x1b[13;2:1u"));

		assert.equal(editor.text, "\n");
		assert.equal(calls.extensionInput, 0);
		assert.equal(calls.enter, 0);
		assert.equal(calls.render, 1);
	});

	it("inserts a newline for LF Shift+Enter before a focused extension can submit it", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: false });

		controller.handleChunk(Buffer.from("\n"));

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

	it("buffers split Command+V image-paste packets before a focused extension can consume them", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: true, shiftPressed: false });
		let clipboardImagePasteCalls = 0;
		const testController = controller as unknown as { pasteHandler: { handleClipboardImagePaste(): Promise<void> } };
		testController.pasteHandler.handleClipboardImagePaste = async () => {
			clipboardImagePasteCalls += 1;
		};

		controller.handleChunk(Buffer.from("\x1b[118;9"));
		controller.handleChunk(Buffer.from(":1u"));

		assert.equal(editor.text, "");
		assert.equal(calls.extensionInput, 0);
		assert.equal(clipboardImagePasteCalls, 1);
	});
});

describe("AppInputController terminal input", () => {
	it("treats xterm modifyOtherKeys Ctrl+C as interrupt instead of inserting sequence text", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("\x1b[27;5;1089~"));

		assert.equal(editor.text, "");
		assert.equal(calls.interrupt, 1);
	});

	it("parses offscreen SGR mouse coordinates", () => {
		const { controller, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("\x1b[<0;-1;2m"));

		assert.deepEqual(calls.mouseEvents, [{ button: 0, x: -1, y: 2, released: true }]);
	});

	it("preserves UTF-8 characters split across Buffer chunks", () => {
		const { controller, editor } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		const input = Buffer.from("A🙂界B", "utf8");

		controller.handleChunk(input.subarray(0, 3));
		controller.handleChunk(input.subarray(3, 5));
		controller.handleChunk(input.subarray(5, 8));
		controller.handleChunk(input.subarray(8));

		assert.equal(editor.text, "A🙂界B");
	});

	it("renders a large plain printable chunk once", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		const input = "plain text ".repeat(1_000);

		controller.handleChunk(Buffer.from(input));

		assert.equal(editor.text, input);
		assert.equal(calls.render, 1);
	});

	it("batches printable runs while preserving embedded key-sequence semantics", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("abc\x1b[DQ!"));

		assert.equal(editor.text, "abQ!c");
		assert.equal(editor.cursor, 4);
		assert.equal(calls.render, 3);
	});

	it("handles common editing, navigation, autocomplete, voice, and stop shortcuts", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("abc"));
		assert.equal(editor.text, "abc");
		controller.handleChunk(Buffer.from("\x1b[D"));
		controller.handleChunk(Buffer.from("\x1b[C"));
		controller.handleChunk(Buffer.from("\x1b[H"));
		controller.handleChunk(Buffer.from("\x1b[F"));
		controller.handleChunk(Buffer.from("\u007f"));
		assert.equal(editor.text, "ab");

		controller.handleChunk(Buffer.from("\t"));
		assert.equal(calls.autocompleteSlash, 1);
		controller.handleChunk(Buffer.from("\u0007"));
		assert.equal(calls.voice, 1);
		controller.handleChunk(Buffer.from("\u000c"));
		controller.handleChunk(Buffer.from("\r"));
		assert.equal(calls.enter, 1);

		editor.setText("");
		controller.handleChunk(Buffer.from("\u0004"));
		assert.equal(calls.stop, 1);
	});

	it("routes arrows through menus, history, multiline editors, and scroll fallback", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		calls.moveMenuResult = true;
		controller.handleChunk(Buffer.from("\x1b[A\x1b[B"));
		assert.deepEqual(calls.menuDeltas, [-1, 1]);

		calls.moveMenuResult = false;
		calls.navigateHistoryResult = true;
		controller.handleChunk(Buffer.from("\x1b[A\x1b[B"));
		assert.deepEqual(calls.historyDeltas, [-1, 1]);

		calls.navigateHistoryResult = false;
		editor.setText("one\ntwo", 5);
		controller.handleChunk(Buffer.from("\x1b[A"));
		assert.equal(editor.cursor, 1);
		controller.handleChunk(Buffer.from("\x1b[B"));
		assert.equal(editor.cursor, 5);

		editor.setText("one", 0);
		controller.handleChunk(Buffer.from("\x1b[A\x1b[B"));
		assert.deepEqual(calls.scrollLines.slice(-2), [-1, 1]);
	});

	it("handles modified key sequences and pending partial sequences", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		editor.setText("hello world", "hello world".length);
		controller.handleChunk(Buffer.from("\x1b[8;9u"));
		assert.equal(editor.text, "");
		controller.handleChunk(Buffer.from("abc"));
		controller.handleChunk(Buffer.from("\x1b[8;1u"));
		assert.equal(editor.text, "ab");

		controller.handleChunk(Buffer.from("\x1b[1;9"));
		assert.equal(calls.scrollPages.length, 0);
		controller.handleChunk(Buffer.from("A"));
		assert.deepEqual(calls.scrollPages, [-1]);
		controller.handleChunk(Buffer.from("\x1b[27;9;66~"));
		assert.deepEqual(calls.scrollPages, [-1, 1]);

		controller.handleChunk(Buffer.from("\x1b[13;2u"));
		assert.match(editor.text, /\n/u);
		controller.handleChunk(Buffer.from("\x1b[5~\x1b[6~"));
		assert.deepEqual(calls.scrollPages.slice(-2), [-1, 1]);
	});

	it("treats LF as newline and CR as submit like pi's editor", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("\n"));
		assert.equal(editor.text, "\n");
		assert.equal(calls.enter, 0);

		controller.handleChunk(Buffer.from("\r"));
		assert.equal(calls.enter, 1);
	});

	it("swallows Kitty key release packets for ordinary text input", () => {
		const { controller, editor } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("h\x1b[104;1:3ue\x1b[101;1:3ul\x1b[108;1:3ul\x1b[108;1:3uo\x1b[111;1:3u"));

		assert.equal(editor.text, "hello");
	});

	it("handles Kitty arrow press packets and swallows their release packets", () => {
		const { controller, editor } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		editor.setText("abc", 1);
		controller.handleChunk(Buffer.from("\x1b[1;1D\x1b[1;1:3D\x1b[1;1C\x1b[1;1:3C"));

		assert.equal(editor.cursor, 1);
		assert.equal(editor.text, "abc");
	});

	it("handles Kitty ESC key packets without leaking [27u into the editor", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		editor.setText("hello", "hello".length);
		controller.handleChunk(Buffer.from("\x1b[27u\x1b[27;1:3u"));

		assert.equal(editor.text, "hello");
		assert.equal(calls.escape, 1);
	});

	it("does not swallow input after Kitty ESC release packets (regression for ESC freeze)", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		editor.setText("ab", 2);
		// ESC press then release, immediately followed by typing that must still arrive.
		controller.handleChunk(Buffer.from("\x1b[27u\x1b[27;1:3uXY"));

		assert.equal(editor.text, "abXY");
		assert.equal(calls.escape, 1);
	});

	it("handles clipboard image paste for Command+V terminal sequences", () => {
		const { controller } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		let clipboardImagePasteCalls = 0;
		const testController = controller as unknown as { pasteHandler: { handleClipboardImagePaste(): Promise<void> } };
		testController.pasteHandler.handleClipboardImagePaste = async () => {
			clipboardImagePasteCalls += 1;
		};

		controller.handleChunk(Buffer.from("\x1b[118;9u\x1b[27;10;118~"));

		assert.equal(clipboardImagePasteCalls, 2);
	});

	it("handles clipboard image paste for non-Latin xterm modifyOtherKeys sequences", () => {
		const { controller, editor } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		let clipboardImagePasteCalls = 0;
		const testController = controller as unknown as { pasteHandler: { handleClipboardImagePaste(): Promise<void> } };
		testController.pasteHandler.handleClipboardImagePaste = async () => {
			clipboardImagePasteCalls += 1;
		};

		controller.handleChunk(Buffer.from("\x1b[27;5;1084~"));

		assert.equal(editor.text, "");
		assert.equal(clipboardImagePasteCalls, 1);
	});

	it("buffers bracketed paste payload without rendering per character", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		const pastedText = ["first line", "second line", "third line"].join("\r\n");

		controller.handleChunk(Buffer.from(`\x1b[200~${pastedText}\x1b[201~`));

		assert.equal(editor.text, "[Pasted ~3 lines] ");
		assert.equal(editor.attachments.length, 1);
		assert.equal(editor.attachments[0]?.kind, "pasted-text");
		assert.equal(calls.render, 1);
	});

	it("keeps a split bracketed paste end sequence out of the pasted payload", async () => {
		const { controller, editor } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });

		controller.handleChunk(Buffer.from("\x1b[200~first\nsecond\x1b[201"));
		controller.handleChunk(Buffer.from("~"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(editor.text, "[Pasted ~2 lines] ");
		assert.equal(editor.attachments[0]?.kind, "pasted-text");
		assert.equal(editor.attachments[0]?.text, "first\nsecond");
	});

	it("executes every registered escape-sequence handler without relying on terminal side effects", () => {
		const { controller, editor, calls } = createController({ extensionInputUsesEditor: false, shiftPressed: false, consumeExtensionInput: false });
		editor.setText("alpha beta\ngamma", 8);
		const sequences = (controller as never as { getEscapeSequences(): Array<[string, () => void]> }).getEscapeSequences();

		for (const [, handler] of sequences) handler();

		assert.equal(sequences.length > 35, true);
		assert.equal(calls.enter >= 2, true);
		assert.deepEqual(calls.scrollPages.slice(0, 2), [-1, 1]);
		assert.equal(calls.render > 10, true);
	});
});

function createController(options: { extensionInputUsesEditor: boolean; shiftPressed: boolean; consumeExtensionInput?: boolean }): {
	controller: AppInputController;
	editor: InputEditor;
	calls: {
		extensionInput: number; enter: number; interrupt: number; escape: number; mouseEvents: unknown[]; render: number;
		autocompleteSlash: number; voice: number; stop: number; scrollLines: number[]; scrollPages: number[];
		menuDeltas: number[]; historyDeltas: number[]; moveMenuResult: boolean; navigateHistoryResult: boolean;
	};
} {
	const editor = new InputEditor();
	const calls = {
		extensionInput: 0, enter: 0, interrupt: 0, escape: 0, mouseEvents: [] as unknown[], render: 0,
		autocompleteSlash: 0, voice: 0, stop: 0, scrollLines: [] as number[], scrollPages: [] as number[],
		menuDeltas: [] as number[], historyDeltas: [] as number[], moveMenuResult: false, navigateHistoryResult: false,
	};
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
		moveActivePopupMenuSelection: (delta) => { calls.menuDeltas.push(delta); return calls.moveMenuResult; },
		navigateRequestHistory: (delta) => { calls.historyDeltas.push(delta); return calls.navigateHistoryResult; },
		scrollByLines: (delta) => { calls.scrollLines.push(delta); },
		scrollByPage: (delta) => { calls.scrollPages.push(delta); },
		handleMouse: (event) => { calls.mouseEvents.push(event); },
		handleEnter: () => {
			calls.enter += 1;
		},
		handleInterrupt: async () => {
			calls.interrupt += 1;
		},
		handleEscape: async () => { calls.escape += 1; },
		handleDirectPopupInput: () => false,
		autocompleteModel: () => false,
		autocompleteThinking: () => false,
		acceptAutocompleteSuggestion: () => false,
		autocompleteSlashCommand: () => { calls.autocompleteSlash += 1; },
		toggleVoiceRecording: () => { calls.voice += 1; },
		stop: async () => { calls.stop += 1; },
	};

	return { controller: new AppInputController(host), editor, calls };
}
