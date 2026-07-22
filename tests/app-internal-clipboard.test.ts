import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PiUiExtendApp } from "../src/app/app.js";
import { InputEditor } from "../src/input-editor.js";

type InternalClipboardTestApp = {
	internalClipboardText: string | undefined;
	inputEditor: InputEditor;
	pasteInternalClipboard(): void;
};

describe("PiUiExtendApp internal clipboard", () => {
	it("inserts copied text at the editor cursor", () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("before after", 7);
		const app = createTestApp(inputEditor, "copied ");

		app.pasteInternalClipboard();

		assert.equal(inputEditor.text, "before copied after");
		assert.equal(inputEditor.cursor, "before copied ".length);
	});

	it("does not modify the editor before Pix has copied text", () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("unchanged");
		const app = createTestApp(inputEditor, undefined);

		app.pasteInternalClipboard();

		assert.equal(inputEditor.text, "unchanged");
	});
});

function createTestApp(inputEditor: InputEditor, internalClipboardText: string | undefined): InternalClipboardTestApp {
	return Object.assign(Object.create(PiUiExtendApp.prototype) as object, {
		internalClipboardText,
		inputEditor,
		requestHistory: { resetNavigation: () => {} },
		popupMenus: { resetInputMenuDismissals: () => {} },
		render: () => {},
		showToast: () => {},
	}) as unknown as InternalClipboardTestApp;
}
