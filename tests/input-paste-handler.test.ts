import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InputPasteHandler } from "../src/app/input/input-paste-handler.js";
import { InputEditor } from "../src/input-editor.js";

type TestPasteHandler = {
	handleFilePaste(filePath: string): Promise<void>;
};

function createHandler(cwd: string): { editor: InputEditor; handler: InputPasteHandler; pasteFile(filePath: string): Promise<void> } {
	const editor = new InputEditor();
	const handler = new InputPasteHandler({
		inputEditor: editor,
		cwd,
		resetRequestHistoryNavigation() {},
		render() {},
	});
	const testHandler = handler as unknown as TestPasteHandler;
	return { editor, handler, pasteFile: (filePath) => testHandler.handleFilePaste(filePath) };
}

describe("InputPasteHandler file paths", () => {
	it("inserts a quoted relative path for files inside the workspace", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-cwd-"));
		const filePath = join(cwd, "nested file.txt");
		await writeFile(filePath, "file body should not be attached");

		const { editor, pasteFile } = createHandler(cwd);
		await pasteFile(filePath);

		assert.equal(editor.text, '"nested file.txt"');
		assert.equal(editor.attachments.length, 0);
	});

	it("inserts a quoted absolute path for files outside the workspace", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-cwd-"));
		const outsideDir = await mkdtemp(join(tmpdir(), "pix-outside-"));
		const filePath = join(outsideDir, "outside.txt");
		await writeFile(filePath, "outside body should not be attached");

		const { editor, pasteFile } = createHandler(cwd);
		await pasteFile(filePath);

		assert.equal(editor.text, `"${filePath}"`);
		assert.equal(editor.attachments.length, 0);
	});

	it("does not treat bracketed multi-line text that starts with a path as a file path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-cwd-"));
		const { editor, handler } = createHandler(cwd);

		handler.beginBracketedPaste();
		handler.appendBracketedPasteText("/tmp/example\nsecond line");
		handler.endBracketedPaste();
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(editor.text, "[Pasted ~2 lines] ");
		assert.equal(editor.attachments.length, 1);
		assert.equal(editor.attachments[0]?.kind, "pasted-text");
	});

	it("tries clipboard image paste when bracketed paste payload is empty", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-cwd-"));
		const { handler } = createHandler(cwd);
		let clipboardImagePasteCalls = 0;
		(handler as unknown as { handleClipboardImagePaste(): Promise<void> }).handleClipboardImagePaste = async () => {
			clipboardImagePasteCalls += 1;
		};

		handler.beginBracketedPaste();
		handler.endBracketedPaste();
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(clipboardImagePasteCalls, 1);
	});
});
