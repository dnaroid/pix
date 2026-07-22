import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { imageMimeTypeForPath, InputEditor, isImagePath, looksLikeFilePath, quoteFilePathForInput, readClipboardImage } from "../src/input-editor.js";

describe("InputEditor text editing", () => {
	it("sets, inserts, clamps cursors, and clears state", () => {
		const editor = new InputEditor();
		editor.setText("abc", 99);
		assert.equal(editor.cursor, 3);
		editor.moveLeft();
		editor.insert("X");
		assert.equal(editor.text, "abXc");
		editor.clear();
		assert.equal(editor.text, "");
		assert.equal(editor.cursor, 0);
		assert.equal(editor.hasAttachments, false);
	});

	it("deletes characters, words, line starts, line ends, and selections", () => {
		const editor = new InputEditor();
		editor.deleteBackward();
		editor.deleteForward();
		editor.deleteWordBackward();
		editor.deleteWordForward();
		editor.setText("one two\nthree", 7);
		editor.deleteWordBackward();
		assert.equal(editor.text, "one \nthree");
		editor.deleteForward();
		assert.equal(editor.text, "one three");
		editor.moveToEnd();
		editor.deleteWordForward();
		assert.equal(editor.text, "one three");
		editor.deleteBackward();
		assert.equal(editor.text, "one thre");
		editor.moveToLineStart();
		editor.moveRight();
		editor.moveRightExtend();
		assert.equal(editor.getSelectedText(), "n");
		editor.deleteSelection();
		assert.equal(editor.text, "oe thre");
		editor.moveToEnd();
		editor.deleteToLineStart();
		assert.equal(editor.text, "");
	});

	it("moves to the previous line end after deleting the current line", () => {
		const editor = new InputEditor();
		editor.setText("one\ntwo\nthree", "one\ntwo\nthree".length);

		editor.deleteToLineStartOrPreviousLineEnd();
		assert.equal(editor.text, "one\ntwo");
		assert.equal(editor.cursor, "one\ntwo".length);

		editor.deleteToLineStartOrPreviousLineEnd();
		assert.equal(editor.text, "one");
		assert.equal(editor.cursor, 3);

		editor.deleteToLineStartOrPreviousLineEnd();
		assert.equal(editor.text, "");
		assert.equal(editor.cursor, 0);
	});

	it("moves by lines, words, starts, ends, and extended selections", () => {
		const editor = new InputEditor();
		editor.setText("ab\nlong\nz", 5);
		editor.moveLeftExtend();
		assert.equal(editor.getSelectedText(), "o");
		editor.clearSelection();
		editor.moveRight();
		editor.moveUp();
		assert.equal(editor.cursor, 2);
		editor.moveDown();
		assert.equal(editor.cursor, 5);
		editor.moveDown();
		assert.equal(editor.cursor, editor.text.length);
		editor.moveUpExtend();
		assert.deepEqual(editor.selection, { anchor: editor.text.length, active: 4 });
		editor.moveToLineStartExtend();
		assert.equal(editor.selection?.active, 3);
		editor.clearSelection();
		editor.moveToStart();
		editor.moveUpExtend();
		assert.deepEqual(editor.selection, { anchor: 0, active: 0 });
		editor.moveDownExtend();
		assert.equal(editor.selection?.active, 3);
		editor.clearSelection();
		editor.moveToStart();
		editor.moveWordRight();
		assert.equal(editor.cursor, 2);
		editor.moveWordLeft();
		assert.equal(editor.cursor, 0);
		editor.moveToLineEndExtend();
		assert.equal(editor.getSelectedText(), "ab");
	});

	it("selects all and replaces active selection on insert", () => {
		const editor = new InputEditor();
		editor.selectAll();
		assert.equal(editor.hasSelection, false);
		editor.setText("abc");
		editor.selectAll();
		assert.equal(editor.getSelectedText(), "abc");
		editor.insert("x");
		assert.equal(editor.text, "x");
	});

	it("undoes and redoes bounded content edits", () => {
		const editor = new InputEditor();
		assert.equal(editor.contentVersion, 0);
		editor.insert("a");
		assert.equal(editor.contentVersion, 1);
		editor.insert("b");
		assert.equal(editor.contentVersion, 2);

		assert.equal(editor.canUndo, true);
		assert.equal(editor.undo(), true);
		assert.equal(editor.text, "a");
		assert.equal(editor.cursor, 1);
		assert.equal(editor.contentVersion, 3);
		assert.equal(editor.canRedo, true);

		assert.equal(editor.redo(), true);
		assert.equal(editor.text, "ab");
		assert.equal(editor.cursor, 2);
		assert.equal(editor.contentVersion, 4);

		editor.insert("c");
		assert.equal(editor.contentVersion, 5);
		assert.equal(editor.canRedo, false);
	});

	it("tracks content version only for content changes", () => {
		const editor = new InputEditor();

		editor.moveLeft();
		editor.selectAll();
		editor.clear();
		assert.equal(editor.contentVersion, 0);

		editor.setText("abc");
		assert.equal(editor.contentVersion, 1);
		editor.moveLeft();
		editor.moveRightExtend();
		assert.equal(editor.contentVersion, 1);

		editor.clear();
		assert.equal(editor.contentVersion, 2);
		editor.clear();
		assert.equal(editor.contentVersion, 2);
	});

	it("restores attachments through undo and redo without surviving clear", () => {
		const editor = new InputEditor();
		editor.attachImage("abc", "image/png");
		editor.deleteBackward();
		assert.equal(editor.attachments.length, 0);

		assert.equal(editor.undo(), true);
		assert.equal(editor.attachments.length, 1);
		assert.match(editor.text, /\[Image 1\]/);

		assert.equal(editor.redo(), true);
		assert.equal(editor.attachments.length, 0);

		editor.insert("draft");
		editor.clear();
		assert.equal(editor.undo(), false);
	});

	it("restores tab drafts without leaking undo or bracketed-paste state", () => {
		const editor = new InputEditor();
		editor.insert("draft from tab one");
		editor.beginBracketedPaste();

		editor.restoreDraftState({ text: "draft from tab two", cursor: 7 });

		assert.equal(editor.text, "draft from tab two");
		assert.equal(editor.cursor, 7);
		assert.equal(editor.canUndo, false);
		assert.equal(editor.canRedo, false);
		assert.equal(editor.isInBracketedPaste, false);
	});
});

describe("InputEditor attachments", () => {
	it("tracks images, pasted text, and files in expanded and prompt text", () => {
		const editor = new InputEditor();
		editor.attachImage("abc", "image/png");
		editor.attachPastedText("one\ntwo");
		editor.attachPastedText("short");
		editor.attachFile("/tmp/readme.txt", "file contents", "text/plain");
		editor.attachFile("/tmp/photo.png", new Uint8Array([1, 2, 3]), "image/png");

		assert.equal(editor.attachments.length, 4);
		assert.equal(editor.images.length, 2);
		assert.match(editor.text, /\[Image 1\]/);
		assert.match(editor.text, /\[Pasted ~2 lines\]/);
		assert.match(editor.text, /short/);
		assert.match(editor.expandedText, /one\ntwo/);
		assert.match(editor.expandedText, /file contents/);
		assert.doesNotMatch(editor.expandedText, /\[Image 1\]/);
		assert.match(editor.promptText, /\[Image 1\]/);
		assert.match(editor.promptText, /file contents/);

		const stringImage = new InputEditor();
		stringImage.attachFile("/tmp/photo.jpg", "base64data", "image/jpeg");
		assert.deepEqual(stringImage.images, [{ type: "image", data: "base64data", mimeType: "image/jpeg" }]);
	});

	it("captures and restores draft attachments", () => {
		const editor = new InputEditor();
		editor.insert("draft ");
		editor.attachImage("base64-image", "image/png");

		const restored = new InputEditor();
		restored.setDraftState(editor.draftState);

		assert.equal(restored.text, "draft [Image 1] ");
		assert.deepEqual(restored.images, [{ type: "image", data: "base64-image", mimeType: "image/png" }]);
		assert.match(restored.promptText, /\[Image 1\]/);

		restored.attachImage("next-image", "image/png");
		assert.match(restored.text, /\[Image 2\]/);
	});

	it("removes attachments atomically by delete and cursor removal", () => {
		const editor = new InputEditor();
		editor.attachImage("abc", "image/png");
		assert.equal(editor.attachments.length, 1);
		editor.deleteBackward();
		assert.equal(editor.text, "");
		assert.equal(editor.attachments.length, 0);

		editor.attachFile("/tmp/a.txt", "content", "text/plain");
		editor.setText(editor.text, 0);
		editor.deleteForward();
		assert.equal(editor.attachments.length, 0);

		editor.attachImage("abc", "image/png");
		editor.setText(editor.text, 3);
		assert.equal(editor.removeAttachmentAtCursor(), true);
		assert.equal(editor.removeAttachmentAtCursor(), false);
	});

	it("expands selections to attachment boundaries", () => {
		const editor = new InputEditor();
		editor.setText("before ");
		editor.attachFile("/tmp/a.txt", "content", "text/plain");
		editor.insert(" after");
		editor.setText(editor.text, 6);
		editor.moveRightExtend();
		editor.moveRightExtend();
		editor.deleteSelection();
		assert.equal(editor.attachments.length, 0);
		assert.equal(editor.text, "before after");
	});
});

describe("InputEditor rendering and helpers", () => {
	it("renders wrapped visual lines, cursor position, scroll offset, and tag spans", () => {
		const editor = new InputEditor();
		editor.attachImage("abc", "image/png");
		editor.insert("abcdefghijklmnopqrstuvwxyz");
		const rendered = editor.render(14, 2, "> ", ". ");
		assert.equal(rendered.visualLines.length > 2, true);
		assert.equal(rendered.scrollOffset > 0, true);
		assert.equal(rendered.cursorVisualRow >= rendered.scrollOffset, true);
		assert.equal(rendered.cursorScreenCol >= 1, true);
		assert.equal(rendered.visualLines.some((line) => line.tagSpans.length > 0), true);

		editor.clear();
		assert.deepEqual(editor.render(10, 3, "> ", ". ").visualLines, [{ text: "> ", wrapped: false, tagSpans: [] }]);
	});

	it("renders an empty cursor line at exact wrap boundaries", () => {
		const editor = new InputEditor();
		editor.setText("abcde");

		let rendered = editor.render(5, 3, "", "");
		assert.deepEqual(rendered.visualLines.map((line) => line.text), ["abcde", ""]);
		assert.equal(rendered.cursorVisualRow, 1);
		assert.equal(rendered.cursorScreenCol, 1);
		assert.equal(rendered.cursorVisible, true);

		editor.setText("abcde\nx", 5);
		rendered = editor.render(5, 4, "", "");
		assert.deepEqual(rendered.visualLines.map((line) => line.text), ["abcde", "", "x"]);
		assert.equal(rendered.cursorVisualRow, 1);
		assert.equal(rendered.cursorScreenCol, 1);
	});

	it("maps rendered click positions back to cursor offsets", () => {
		const editor = new InputEditor();
		editor.setText("abcdef\nghi");

		assert.equal(editor.offsetAtVisualPosition(0, 1, 4, "", ""), 0);
		assert.equal(editor.offsetAtVisualPosition(0, 3, 4, "", ""), 2);
		assert.equal(editor.offsetAtVisualPosition(1, 4, 4, "", ""), 6);
		assert.equal(editor.offsetAtVisualPosition(2, 2, 4, "", ""), 8);
		assert.equal(editor.offsetAtVisualPosition(99, 1, 4, "", ""), editor.text.length);

		editor.setCursor(editor.offsetAtVisualPosition(2, 2, 4, "", ""));
		assert.equal(editor.cursor, 8);
	});

	it("keeps a manual visual scroll offset until editing or cursor movement", () => {
		const editor = new InputEditor();
		editor.setText("one\ntwo\nthree\nfour\nfive");
		editor.moveToEnd();

		assert.equal(editor.setVisualScrollOffset(1, 20, 2, "", ""), true);
		let rendered = editor.render(20, 2, "", "");
		assert.equal(rendered.scrollOffset, 1);
		assert.equal(rendered.cursorVisible, false);

		assert.equal(editor.scrollByVisualLines(2, 20, 2, "", ""), true);
		rendered = editor.render(20, 2, "", "");
		assert.equal(rendered.scrollOffset, 3);

		editor.insert("!");
		rendered = editor.render(20, 2, "", "");
		assert.equal(rendered.cursorVisible, true);
		assert.equal(rendered.cursorVisualRow >= rendered.scrollOffset, true);
	});

	it("tracks bracketed paste depth", () => {
		const editor = new InputEditor();
		assert.equal(editor.isInBracketedPaste, false);
		editor.beginBracketedPaste();
		editor.beginBracketedPaste();
		assert.equal(editor.isInBracketedPaste, true);
		editor.endBracketedPaste();
		editor.endBracketedPaste();
		editor.endBracketedPaste();
		assert.equal(editor.isInBracketedPaste, false);
	});

	it("detects image paths, MIME types, and pasted file paths", () => {
		assert.equal(isImagePath("PHOTO.PNG"), true);
		assert.equal(isImagePath("file.txt"), false);
		assert.equal(imageMimeTypeForPath("a.jpeg"), "image/jpeg");
		assert.equal(imageMimeTypeForPath("a.svg"), "application/octet-stream");
		assert.equal(quoteFilePathForInput("/tmp/a b.txt"), '"/tmp/a b.txt"');
		assert.equal(quoteFilePathForInput('/tmp/a"b.txt'), '"/tmp/a\\"b.txt"');
		assert.equal(looksLikeFilePath(" '/tmp/a b.txt' "), "/tmp/a b.txt");
		assert.equal(looksLikeFilePath("file:///tmp/a.txt"), "/tmp/a.txt");
		assert.equal(looksLikeFilePath("./relative"), "./relative");
		assert.equal(looksLikeFilePath("C:\\tmp\\a.txt"), "C:\\tmp\\a.txt");
		assert.equal(looksLikeFilePath("not a path"), null);
		assert.equal(looksLikeFilePath("file://%"), null);
	});

	it("reads clipboard images defensively", async () => {
		const image = await readClipboardImage();
		if (image) {
			assert.equal(typeof image.data, "string");
			assert.equal(typeof image.mimeType, "string");
		} else {
			assert.equal(image, null);
		}
	});
});
