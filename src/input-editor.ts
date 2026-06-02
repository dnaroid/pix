/**
 * InputEditor — multiline text input with cursor, selection, word ops, and paste.
 *
 * Supports attachments: images, pasted text blocks, and file references are
 * tracked as virtual tags in the text (e.g. `[Image 1]`, `[Pasted 42 lines]`,
 * `[File: foo.ts]`). The actual data is stored separately and collected on submit.
 */

export { imageMimeTypeForPath, isImagePath, looksLikeFilePath, quoteFilePathForInput, readClipboardImage, type ClipboardImage } from "./input-editor-files.js";

// ── Types ───────────────────────────────────────────────────────────

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** An attachment tracked alongside the text input. */
export type Attachment =
	| { kind: "image"; tag: string; image: ImageContent }
	| { kind: "pasted-text"; tag: string; text: string; lineCount: number }
	| { kind: "file"; tag: string; path: string; content?: string; image?: ImageContent };

/** A range of selected text (anchor = where selection started). */
export interface Selection {
	anchor: number;
	active: number;
}

/** One visual line produced by the editor for rendering. */
export interface VisualLine {
	text: string;
	/** true when this line was soft-wrapped from a longer logical line. */
	wrapped: boolean;
	/** Attachment tag spans within this visual line, for distinct styling. */
	tagSpans: Array<{ start: number; end: number }>;
	/** Inline autocomplete suggestion spans within this visual line. */
	suggestionSpans?: Array<{ start: number; end: number }>;
}

/** Full render-ready snapshot of the editor state. */
export interface RenderedEditor {
	visualLines: VisualLine[];
	cursorVisualRow: number;
	cursorScreenCol: number;
	scrollOffset: number;
	cursorVisible: boolean;
}

interface AttachmentTagRange {
	attachmentIndex: number;
	start: number;
	/** Exclusive end offset of the tag itself. */
	end: number;
	/** Exclusive end offset including one trailing space inserted with the tag. */
	removeEnd: number;
}

// ── Constants ───────────────────────────────────────────────────────

const PASTE_SUMMARY_MIN_LINES = 2;
const INPUT_UNDO_MAX_STATES = 64;
const INPUT_UNDO_MAX_TEXT_CHARS = 128 * 1024;
const INPUT_UNDO_MAX_ATTACHMENT_REFS = 256;
const INPUT_UNDO_MAX_SNAPSHOT_TEXT_CHARS = 32 * 1024;
const INPUT_UNDO_MAX_SNAPSHOT_ATTACHMENT_REFS = 64;

interface EditorSnapshot {
	text: string;
	cursor: number;
	selection: Selection | undefined;
	attachments: readonly Attachment[];
	imageCounter: number;
	pasteCounter: number;
}

// ── InputEditor ─────────────────────────────────────────────────────

export class InputEditor {
	private _text = "";
	private _cursor = 0;
	private _selection: Selection | undefined;
	private _bracketedPasteDepth = 0;
	private _scrollOffset: number | undefined;
	private readonly _attachments: Attachment[] = [];
	private _imageCounter = 0;
	private _pasteCounter = 0;
	private readonly _undoStack: EditorSnapshot[] = [];
	private readonly _redoStack: EditorSnapshot[] = [];
	private _historyMutationDepth = 0;
	private _restoringHistory = false;

	// ── public getters ──────────────────────────────────────────────

	get text(): string { return this._text; }
	get cursor(): number { return this._cursor; }
	get selection(): Selection | undefined { return this._selection; }
	get hasSelection(): boolean {
		return !!this._selection && this._selection.anchor !== this._selection.active;
	}
	get attachments(): readonly Attachment[] { return this._attachments; }
	get hasAttachments(): boolean { return this._attachments.length > 0; }
	get canUndo(): boolean { return this._undoStack.length > 0; }
	get canRedo(): boolean { return this._redoStack.length > 0; }

	/** Get only image attachments. */
	get images(): ImageContent[] {
		const images: ImageContent[] = [];
		for (const a of this._attachments) {
			if (a.kind === "image") images.push(a.image);
			else if (a.kind === "file" && a.image) images.push(a.image);
		}
		return images;
	}

	/** Get the text to submit — virtual attachment tags are expanded or removed. */
	get expandedText(): string {
		let result = this._text;
		for (const att of this._attachments) {
			if (att.kind === "pasted-text") {
				result = result.replace(att.tag, att.text);
			} else if (att.kind === "file" && att.content !== undefined) {
				result = result.replace(att.tag, att.content);
			} else {
				result = removeVirtualAttachmentTag(result, att.tag);
			}
		}
		return result;
	}

	/**
	 * Get the text to send to the SDK.
	 *
	 * Like opencode, image attachments keep their virtual marker in the text
	 * while the actual image is sent separately. That keeps image-only prompts
	 * non-empty without showing the marker in our rendered user message.
	 */
	get promptText(): string {
		let result = this._text;
		for (const att of this._attachments) {
			if (att.kind === "pasted-text") {
				result = result.replace(att.tag, att.text);
			} else if (att.kind === "file" && att.content !== undefined) {
				result = result.replace(att.tag, att.content);
			}
		}
		return result;
	}

	// ── mutations ───────────────────────────────────────────────────

	setText(text: string, cursor?: number): void {
		this.recordEdit(() => {
			this._text = text;
			this._cursor = cursor ?? text.length;
			this.clampCursor();
			this.clearSelection();
		});
	}

	clear(): void {
		this._text = "";
		this._cursor = 0;
		this.clearSelection();
		this.clearScrollOffset();
		this._attachments.length = 0;
		this._imageCounter = 0;
		this._pasteCounter = 0;
		this.clearHistory();
	}

	undo(): boolean {
		const previous = this._undoStack.pop();
		if (!previous) return false;

		const current = this.captureHistorySnapshot();
		if (this.isRecordableHistorySnapshot(current)) {
			this._redoStack.push(current);
		} else {
			this._redoStack.length = 0;
		}

		this.restoreHistorySnapshot(previous);
		this.trimHistory();
		return true;
	}

	redo(): boolean {
		const next = this._redoStack.pop();
		if (!next) return false;

		const current = this.captureHistorySnapshot();
		if (this.isRecordableHistorySnapshot(current)) {
			this._undoStack.push(current);
		} else {
			this._undoStack.length = 0;
		}

		this.restoreHistorySnapshot(next);
		this.trimHistory();
		return true;
	}

	/** Insert text at the cursor, replacing any active selection. */
	insert(text: string): void {
		if (!text && !this.hasSelection) return;
		this.recordEdit(() => {
			this.deleteSelection();
			const before = this._text.slice(0, this._cursor);
			const after = this._text.slice(this._cursor);
			this._text = before + text + after;
			this._cursor += text.length;
		});
	}

	deleteBackward(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			if (this._cursor <= 0) return;
			if (this.removeAttachmentForBackwardDelete()) return;
			this._text = this._text.slice(0, this._cursor - 1) + this._text.slice(this._cursor);
			this._cursor -= 1;
		});
	}

	deleteForward(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			if (this._cursor >= this._text.length) return;
			if (this.removeAttachmentForForwardDelete()) return;
			this._text = this._text.slice(0, this._cursor) + this._text.slice(this._cursor + 1);
		});
	}

	deleteToLineStart(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			const lineStart = this.findLineStart(this._cursor);
			if (lineStart === this._cursor) return;
			this._text = this._text.slice(0, lineStart) + this._text.slice(this._cursor);
			this._cursor = lineStart;
		});
	}

	deleteToLineStartOrPreviousLineEnd(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			const lineStart = this.findLineStart(this._cursor);
			if (lineStart < this._cursor) {
				const deleteStart = lineStart > 0 ? lineStart - 1 : lineStart;
				this._text = this._text.slice(0, deleteStart) + this._text.slice(this._cursor);
				this._cursor = deleteStart;
				return;
			}

			if (this._cursor <= 0) return;
			const deleteStart = this._cursor - 1;
			this._text = this._text.slice(0, deleteStart) + this._text.slice(this._cursor);
			this._cursor = deleteStart;
		});
	}

	deleteWordBackward(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			if (this._cursor <= 0) return;
			const wordStart = this.findWordStart(this._cursor);
			this._text = this._text.slice(0, wordStart) + this._text.slice(this._cursor);
			this._cursor = wordStart;
		});
	}

	deleteWordForward(): void {
		this.recordEdit(() => {
			if (this.hasSelection) { this.deleteSelection(); return; }
			if (this._cursor >= this._text.length) return;
			const wordEnd = this.findWordEnd(this._cursor);
			this._text = this._text.slice(0, this._cursor) + this._text.slice(wordEnd);
		});
	}

	// ── attachment operations ───────────────────────────────────────

	/**
	 * Attach an image. Inserts a virtual tag `[Image N]` at the cursor.
	 */
	attachImage(data: string, mimeType: string): void {
		this.recordEdit(() => {
			this._imageCounter += 1;
			const tag = `[Image ${this._imageCounter}]`;
			this._attachments.push({ kind: "image", tag, image: { type: "image", data, mimeType } });
			this.insert(`${tag} `);
		});
	}

	/**
	 * Attach pasted multi-line text. Inserts a virtual tag `[Pasted ~N lines]`
	 * at the cursor if the text exceeds the threshold; otherwise inserts inline.
	 */
	attachPastedText(text: string): void {
		this.recordEdit(() => {
			const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const lineCount = (normalized.match(/\n/g)?.length ?? 0) + 1;

			if (lineCount >= PASTE_SUMMARY_MIN_LINES || normalized.length > 200) {
				this._pasteCounter += 1;
				const tag = `[Pasted ~${lineCount} lines]`;
				this._attachments.push({ kind: "pasted-text", tag, text: normalized, lineCount });
				this.insert(`${tag} `);
			} else {
				// Short text: insert inline
				this.insert(normalized);
			}
		});
	}

	/**
	 * Attach a file. For images, creates an image attachment; for text,
	 * creates a file reference. Inserts `[File: name]` tag.
	 */
	attachFile(filePath: string, content: string | Uint8Array, mimeType: string): void {
		this.recordEdit(() => {
			const basename = filePath.split("/").pop() ?? filePath;

			if (mimeType.startsWith("image/")) {
				const data = typeof content === "string"
					? content
					: Buffer.from(content).toString("base64");
				this._imageCounter += 1;
				const tag = `[Image ${this._imageCounter}: ${basename}]`;
				this._attachments.push({
					kind: "file",
					tag,
					path: filePath,
					image: { type: "image", data, mimeType },
				});
				this.insert(`${tag} `);
			} else {
				const tag = `[File: ${basename}]`;
				this._attachments.push({
					kind: "file",
					tag,
					path: filePath,
					content: typeof content === "string" ? content : Buffer.from(content).toString("utf-8"),
				});
				this.insert(`${tag} `);
			}
		});
	}

	/**
	 * Remove the attachment whose tag is at or near the cursor.
	 * Returns true if an attachment was removed.
	 */
	removeAttachmentAtCursor(): boolean {
		let removed = false;
		this.recordEdit(() => {
			for (const range of this.attachmentTagRanges()) {
				if (this._cursor >= range.start && this._cursor <= range.removeEnd) {
					this.removeAttachmentRange(range);
					removed = true;
					return;
				}
			}
		});
		return removed;
	}

	// ── cursor movement ─────────────────────────────────────────────

	moveLeft(): void { this.clearSelection(); this.clearScrollOffset(); if (this._cursor > 0) this._cursor -= 1; }
	moveRight(): void { this.clearSelection(); this.clearScrollOffset(); if (this._cursor < this._text.length) this._cursor += 1; }

	moveUp(): void {
		this.clearSelection();
		this.clearScrollOffset();
		const pos = this.offsetToRowCol(this._cursor);
		if (pos.row <= 0) { this._cursor = 0; return; }
		this._cursor = this.rowColToOffset(pos.row - 1, pos.col);
	}

	moveDown(): void {
		this.clearSelection();
		this.clearScrollOffset();
		const pos = this.offsetToRowCol(this._cursor);
		const lines = this.logicalLines();
		if (pos.row >= lines.length - 1) { this._cursor = this._text.length; return; }
		this._cursor = this.rowColToOffset(pos.row + 1, pos.col);
	}

	moveToLineStart(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = this.findLineStart(this._cursor); }
	moveToLineEnd(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = this.findLineEnd(this._cursor); }
	moveToStart(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = 0; }
	moveToEnd(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = this._text.length; }
	moveWordLeft(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = this.findWordStart(this._cursor); }
	moveWordRight(): void { this.clearSelection(); this.clearScrollOffset(); this._cursor = this.findWordEnd(this._cursor); }
	setCursor(offset: number, options: { preserveScroll?: boolean } = {}): void {
		this.clearSelection();
		if (!options.preserveScroll) this.clearScrollOffset();
		this._cursor = offset;
		this.clampCursor();
	}

	// ── selection ───────────────────────────────────────────────────

	moveLeftExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		if (this._cursor > 0) this._cursor -= 1;
		this.syncSelectionActive();
	}

	moveRightExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		if (this._cursor < this._text.length) this._cursor += 1;
		this.syncSelectionActive();
	}

	moveUpExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		const pos = this.offsetToRowCol(this._cursor);
		if (pos.row <= 0) { this._cursor = 0; this.syncSelectionActive(); return; }
		this._cursor = this.rowColToOffset(pos.row - 1, pos.col);
		this.syncSelectionActive();
	}

	moveDownExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		const pos = this.offsetToRowCol(this._cursor);
		const lines = this.logicalLines();
		if (pos.row >= lines.length - 1) { this._cursor = this._text.length; this.syncSelectionActive(); return; }
		this._cursor = this.rowColToOffset(pos.row + 1, pos.col);
		this.syncSelectionActive();
	}

	moveToLineStartExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		this._cursor = this.findLineStart(this._cursor);
		this.syncSelectionActive();
	}

	moveToLineEndExtend(): void {
		this.clearScrollOffset();
		this.extendSelection();
		this._cursor = this.findLineEnd(this._cursor);
		this.syncSelectionActive();
	}

	getSelectedText(): string | undefined {
		if (!this.hasSelection) return undefined;
		const [start, end] = this.orderedSelection();
		return this._text.slice(start, end);
	}

	deleteSelection(): void {
		this.recordEdit(() => {
			if (!this.hasSelection) return;
			const [selectionStart, selectionEnd] = this.orderedSelection();
			const { start, end, attachmentIndexes } = this.expandRangeToAttachmentBoundaries(selectionStart, selectionEnd);
			this._text = this._text.slice(0, start) + this._text.slice(end);
			for (const index of [...attachmentIndexes].sort((a, b) => b - a)) {
				this._attachments.splice(index, 1);
			}
			this._cursor = start;
			this.clearSelection();
		});
	}

	clearSelection(): void { this._selection = undefined; }

	selectAll(): void {
		if (this._text.length === 0) return;
		this._selection = { anchor: 0, active: this._text.length };
	}

	// ── bracketed paste ─────────────────────────────────────────────

	beginBracketedPaste(): void { this._bracketedPasteDepth += 1; }
	endBracketedPaste(): void { this._bracketedPasteDepth = Math.max(0, this._bracketedPasteDepth - 1); }
	get isInBracketedPaste(): boolean { return this._bracketedPasteDepth > 0; }

	// ── rendering ───────────────────────────────────────────────────

	render(width: number, maxRows: number, firstPrefix: string, continuationPrefix: string, suggestionSuffix = ""): RenderedEditor {
		const allVisual: VisualLine[] = [];
		const canRenderSuggestion = suggestionSuffix.length > 0 && !this.hasSelection && this._cursor === this._text.length;
		const renderedText = canRenderSuggestion ? `${this._text}${suggestionSuffix}` : this._text;
		const logicalLines = renderedText.split("\n");
		const tagPatterns = this.getTagPatterns();
		const suggestionStart = canRenderSuggestion ? this._text.length : undefined;
		let lineOffset = 0;

		for (let i = 0; i < logicalLines.length; i++) {
			const line = logicalLines[i]!;
			const prefix = i === 0 && allVisual.length === 0 ? firstPrefix : continuationPrefix;
			this.pushVisualLines(allVisual, line, prefix, continuationPrefix, width, i === 0 && allVisual.length === 0, tagPatterns, lineOffset, suggestionStart, renderedText.length);
			lineOffset += line.length + (i < logicalLines.length - 1 ? 1 : 0);
		}

		if (allVisual.length === 0) {
			allVisual.push({ text: firstPrefix, wrapped: false, tagSpans: [] });
		}

		const cursorVisualRow = this.computeCursorVisualRow(allVisual, width, firstPrefix, continuationPrefix);

		// When the cursor is at the exact end of a logical line that fills the width,
		// render an empty wrapped line for the cursor. If another logical line follows,
		// insert the cursor line before it instead of letting the cursor cover its first cell.
		if (!canRenderSuggestion && this.cursorAtExactWrapBoundary(width, firstPrefix, continuationPrefix)) {
			const cursorLine: VisualLine = { text: continuationPrefix, wrapped: true, tagSpans: [] };
			if (cursorVisualRow >= allVisual.length) {
				allVisual.push(cursorLine);
			} else {
				allVisual.splice(cursorVisualRow, 0, cursorLine);
			}
		}

		const safeMaxRows = Math.max(1, maxRows);
		let autoScrollOffset = 0;
		if (allVisual.length > safeMaxRows) {
			if (cursorVisualRow >= safeMaxRows) {
				autoScrollOffset = cursorVisualRow - safeMaxRows + 1;
			}
			autoScrollOffset = Math.min(autoScrollOffset, Math.max(0, allVisual.length - safeMaxRows));
		}

		const maxScrollOffset = Math.max(0, allVisual.length - safeMaxRows);
		const scrollOffset = Math.max(0, Math.min(maxScrollOffset, this._scrollOffset ?? autoScrollOffset));
		const cursorVisible = cursorVisualRow >= scrollOffset && cursorVisualRow < scrollOffset + safeMaxRows;

		const cursorScreenCol = this.computeCursorScreenCol(width, firstPrefix, continuationPrefix);

		return { visualLines: allVisual, cursorVisualRow, cursorScreenCol, scrollOffset, cursorVisible };
	}

	scrollByVisualLines(delta: number, width: number, maxRows: number, firstPrefix: string, continuationPrefix: string): boolean {
		const rendered = this.render(width, maxRows, firstPrefix, continuationPrefix);
		return this.setVisualScrollOffset(rendered.scrollOffset + delta, width, maxRows, firstPrefix, continuationPrefix);
	}

	setVisualScrollOffset(offset: number, width: number, maxRows: number, firstPrefix: string, continuationPrefix: string): boolean {
		const rendered = this.render(width, maxRows, firstPrefix, continuationPrefix);
		const maxScrollOffset = Math.max(0, rendered.visualLines.length - Math.max(1, maxRows));
		if (maxScrollOffset <= 0) {
			const changed = this._scrollOffset !== undefined;
			this.clearScrollOffset();
			return changed;
		}

		const nextOffset = Math.max(0, Math.min(maxScrollOffset, offset));
		if (nextOffset === rendered.scrollOffset && this._scrollOffset !== undefined) return false;

		this._scrollOffset = nextOffset;
		return true;
	}

	/** Convert a rendered visual row and 1-based terminal column into a text cursor offset. */
	offsetAtVisualPosition(visualRow: number, screenColumn: number, width: number, firstPrefix: string, continuationPrefix: string): number {
		const targetVisualRow = Math.max(0, visualRow);
		const targetColumn = Math.max(1, screenColumn);
		const logicalLines = this.logicalLines();
		let currentVisualRow = 0;
		let logicalOffset = 0;

		for (let logicalRow = 0; logicalRow < logicalLines.length; logicalRow += 1) {
			const line = logicalLines[logicalRow]!;
			let currentPrefix = logicalRow === 0 ? firstPrefix : continuationPrefix;

			if (line.length === 0) {
				if (currentVisualRow === targetVisualRow) return logicalOffset;
				currentVisualRow += 1;
				logicalOffset += logicalRow < logicalLines.length - 1 ? 1 : 0;
				continue;
			}

			let chunkStart = 0;
			while (chunkStart < line.length) {
				const available = Math.max(1, width - currentPrefix.length);
				const chunkEnd = Math.min(line.length, chunkStart + available);
				if (currentVisualRow === targetVisualRow) {
					const columnInChunk = Math.max(0, Math.min(chunkEnd - chunkStart, targetColumn - currentPrefix.length - 1));
					return logicalOffset + chunkStart + columnInChunk;
				}

				currentVisualRow += 1;
				chunkStart = chunkEnd;
				currentPrefix = continuationPrefix;
			}

			logicalOffset += line.length + (logicalRow < logicalLines.length - 1 ? 1 : 0);
		}

		return this._text.length;
	}

	// ── private helpers ─────────────────────────────────────────────

	private recordEdit(mutator: () => void): void {
		if (this._restoringHistory || this._historyMutationDepth > 0) {
			mutator();
			return;
		}

		const before = this.captureHistorySnapshot();
		this._historyMutationDepth += 1;
		try {
			mutator();
		} finally {
			this._historyMutationDepth -= 1;
		}

		if (!this.didContentChangeFrom(before)) return;
		this.clearScrollOffset();
		if (!this.isRecordableHistorySnapshot(before)) {
			this.clearHistory();
			return;
		}

		this._undoStack.push(before);
		this._redoStack.length = 0;
		this.trimHistory();
	}

	private captureHistorySnapshot(): EditorSnapshot {
		return {
			text: this._text,
			cursor: this._cursor,
			selection: this._selection ? { ...this._selection } : undefined,
			attachments: [...this._attachments],
			imageCounter: this._imageCounter,
			pasteCounter: this._pasteCounter,
		};
	}

	private restoreHistorySnapshot(snapshot: EditorSnapshot): void {
		this._restoringHistory = true;
		try {
			this._text = snapshot.text;
			this._cursor = snapshot.cursor;
			this._selection = snapshot.selection ? { ...snapshot.selection } : undefined;
			this._attachments.length = 0;
			this._attachments.push(...snapshot.attachments);
			this._imageCounter = snapshot.imageCounter;
			this._pasteCounter = snapshot.pasteCounter;
			this.clearScrollOffset();
			this.clampCursor();
		} finally {
			this._restoringHistory = false;
		}
	}

	private didContentChangeFrom(snapshot: EditorSnapshot): boolean {
		return this._text !== snapshot.text || !this.sameAttachmentRefs(snapshot.attachments);
	}

	private sameAttachmentRefs(attachments: readonly Attachment[]): boolean {
		if (this._attachments.length !== attachments.length) return false;
		return this._attachments.every((attachment, index) => attachment === attachments[index]);
	}

	private isRecordableHistorySnapshot(snapshot: EditorSnapshot): boolean {
		return snapshot.text.length <= INPUT_UNDO_MAX_SNAPSHOT_TEXT_CHARS
			&& snapshot.attachments.length <= INPUT_UNDO_MAX_SNAPSHOT_ATTACHMENT_REFS;
	}

	private clearHistory(): void {
		this._undoStack.length = 0;
		this._redoStack.length = 0;
	}

	private clearScrollOffset(): void {
		this._scrollOffset = undefined;
	}

	private trimHistory(): void {
		while (this._undoStack.length > INPUT_UNDO_MAX_STATES) this._undoStack.shift();
		while (this._redoStack.length > INPUT_UNDO_MAX_STATES) this._redoStack.shift();

		while (
			this.totalHistoryTextChars() > INPUT_UNDO_MAX_TEXT_CHARS
			|| this.totalHistoryAttachmentRefs() > INPUT_UNDO_MAX_ATTACHMENT_REFS
		) {
			if (this._undoStack.length > 0) this._undoStack.shift();
			else if (this._redoStack.length > 0) this._redoStack.shift();
			else break;
		}
	}

	private totalHistoryTextChars(): number {
		return this.historyTextChars(this._undoStack) + this.historyTextChars(this._redoStack);
	}

	private totalHistoryAttachmentRefs(): number {
		return this.historyAttachmentRefs(this._undoStack) + this.historyAttachmentRefs(this._redoStack);
	}

	private historyTextChars(snapshots: readonly EditorSnapshot[]): number {
		let total = 0;
		for (const snapshot of snapshots) total += snapshot.text.length;
		return total;
	}

	private historyAttachmentRefs(snapshots: readonly EditorSnapshot[]): number {
		let total = 0;
		for (const snapshot of snapshots) total += snapshot.attachments.length;
		return total;
	}

	private clampCursor(): void {
		this._cursor = Math.max(0, Math.min(this._text.length, this._cursor));
	}

	private extendSelection(): void {
		if (!this._selection) {
			this._selection = { anchor: this._cursor, active: this._cursor };
		}
	}

	private syncSelectionActive(): void {
		if (this._selection) {
			this._selection = { anchor: this._selection.anchor, active: this._cursor };
		}
	}

	private orderedSelection(): [number, number] {
		if (!this._selection) return [this._cursor, this._cursor];
		const a = this._selection.anchor;
		const b = this._selection.active;
		return a < b ? [a, b] : [b, a];
	}

	private removeAttachmentForBackwardDelete(): boolean {
		for (const range of this.attachmentTagRanges()) {
			// Backspace immediately after a tag (or its trailing space), or inside a
			// tag, removes the whole virtual tag and its attachment atomically.
			if (this._cursor > range.start && this._cursor <= range.removeEnd) {
				this.removeAttachmentRange(range);
				return true;
			}
		}
		return false;
	}

	private removeAttachmentForForwardDelete(): boolean {
		for (const range of this.attachmentTagRanges()) {
			// Delete at the start of a tag, or inside it, removes the whole virtual
			// tag and its attachment atomically.
			if (this._cursor >= range.start && this._cursor < range.end) {
				this.removeAttachmentRange(range);
				return true;
			}
		}
		return false;
	}

	private removeAttachmentRange(range: AttachmentTagRange): void {
		this._text = this._text.slice(0, range.start) + this._text.slice(range.removeEnd);
		this._cursor = range.start;
		this._attachments.splice(range.attachmentIndex, 1);
	}

	private attachmentTagRanges(): AttachmentTagRange[] {
		const ranges: AttachmentTagRange[] = [];
		for (let attachmentIndex = 0; attachmentIndex < this._attachments.length; attachmentIndex += 1) {
			const tag = this._attachments[attachmentIndex]!.tag;
			const start = this._text.indexOf(tag);
			if (start < 0) continue;
			const end = start + tag.length;
			const removeEnd = this._text[end] === " " ? end + 1 : end;
			ranges.push({ attachmentIndex, start, end, removeEnd });
		}
		return ranges.sort((a, b) => a.start - b.start);
	}

	private expandRangeToAttachmentBoundaries(start: number, end: number): {
		start: number;
		end: number;
		attachmentIndexes: Set<number>;
	} {
		let expandedStart = start;
		let expandedEnd = end;
		const attachmentIndexes = new Set<number>();
		let changed = true;

		while (changed) {
			changed = false;
			for (const range of this.attachmentTagRanges()) {
				const overlaps = expandedStart < range.removeEnd && expandedEnd > range.start;
				if (!overlaps) continue;
				attachmentIndexes.add(range.attachmentIndex);
				if (range.start < expandedStart) {
					expandedStart = range.start;
					changed = true;
				}
				if (range.removeEnd > expandedEnd) {
					expandedEnd = range.removeEnd;
					changed = true;
				}
			}
		}

		return { start: expandedStart, end: expandedEnd, attachmentIndexes };
	}

	private logicalLines(): string[] { return this._text.split("\n"); }

	private findLineStart(offset: number): number {
		const idx = this._text.lastIndexOf("\n", offset - 1);
		return idx < 0 ? 0 : idx + 1;
	}

	private findLineEnd(offset: number): number {
		const idx = this._text.indexOf("\n", offset);
		return idx < 0 ? this._text.length : idx;
	}

	private findWordStart(offset: number): number {
		let pos = offset;
		while (pos > 0 && /\s/.test(this._text[pos - 1]!)) pos -= 1;
		while (pos > 0 && /\S/.test(this._text[pos - 1]!)) pos -= 1;
		return pos;
	}

	private findWordEnd(offset: number): number {
		let pos = offset;
		while (pos < this._text.length && /\s/.test(this._text[pos]!)) pos += 1;
		while (pos < this._text.length && /\S/.test(this._text[pos]!)) pos += 1;
		return pos;
	}

	private offsetToRowCol(offset: number): { row: number; col: number } {
		const lines = this.logicalLines();
		let remaining = offset;
		for (let row = 0; row < lines.length; row++) {
			const line = lines[row]!;
			if (remaining <= line.length) return { row, col: remaining };
			remaining -= line.length + 1;
		}
		const lastRow = lines.length - 1;
		return { row: lastRow, col: lines[lastRow]!.length };
	}

	private rowColToOffset(row: number, col: number): number {
		const lines = this.logicalLines();
		let offset = 0;
		for (let r = 0; r < lines.length; r++) {
			if (r === row) return offset + Math.min(col, lines[r]!.length);
			offset += lines[r]!.length + 1;
		}
		return this._text.length;
	}

	/** Get regex patterns for all attachment tags in the text. */
	private getTagPatterns(): Array<{ tag: string; regex: RegExp }> {
		return this._attachments.map((att) => ({
			tag: att.tag,
			regex: new RegExp(escapeRegex(att.tag), "g"),
		}));
	}

	/** Find tag spans within a text string (offsets relative to the text). */
	private findTagSpans(text: string, tagPatterns: Array<{ tag: string; regex: RegExp }>): Array<{ start: number; end: number }> {
		const spans: Array<{ start: number; end: number }> = [];
		for (const { regex } of tagPatterns) {
			regex.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				spans.push({ start: match.index, end: match.index + match[0].length });
			}
		}
		return spans;
	}

	private pushVisualLines(
		output: VisualLine[],
		logicalLine: string,
		firstPrefix: string,
		continuationPrefix: string,
		width: number,
		isFirst: boolean,
		tagPatterns: Array<{ tag: string; regex: RegExp }>,
		lineOffset: number,
		suggestionStart: number | undefined,
		suggestionEnd: number,
	): void {
		let currentPrefix = firstPrefix;
		let remaining = logicalLine;
		let chunkGlobalStart = lineOffset;

		if (remaining.length === 0) {
			output.push({ text: currentPrefix, wrapped: !isFirst || output.length > 0, tagSpans: [] });
			return;
		}

		let first = true;
		while (remaining.length > 0) {
			const available = Math.max(1, width - currentPrefix.length);
			const chunk = remaining.slice(0, available);
			const fullText = `${currentPrefix}${chunk}`;
			const chunkGlobalEnd = chunkGlobalStart + chunk.length;
			// Compute tag spans adjusted for prefix offset
			const spans = this.findTagSpans(chunk, tagPatterns).map((s) => ({
				start: s.start + currentPrefix.length,
				end: s.end + currentPrefix.length,
			}));
			const suggestionSpans = suggestionStart === undefined ? undefined : suggestionSpansForChunk(
				chunkGlobalStart,
				chunkGlobalEnd,
				suggestionStart,
				suggestionEnd,
				currentPrefix.length,
			);
			output.push({ text: fullText, wrapped: !first, tagSpans: spans, ...(suggestionSpans && suggestionSpans.length > 0 ? { suggestionSpans } : {}) });
			remaining = remaining.slice(chunk.length);
			chunkGlobalStart = chunkGlobalEnd;
			currentPrefix = continuationPrefix;
			first = false;
		}
	}

	private computeCursorVisualRow(
		allVisual: VisualLine[],
		width: number,
		firstPrefix: string,
		continuationPrefix: string,
	): number {
		const pos = this.offsetToRowCol(this._cursor);
		const logicalLines = this.logicalLines();

		let visualRow = 0;
		for (let logRow = 0; logRow < logicalLines.length; logRow++) {
			const line = logicalLines[logRow]!;
			const prefix = logRow === 0 ? firstPrefix : continuationPrefix;
			const prefixLen = prefix.length;
			const available = Math.max(1, width - prefixLen);

			if (line.length === 0) {
				if (logRow === pos.row) return visualRow;
				visualRow += 1;
				continue;
			}

			const wrappedCount = Math.ceil(line.length / available);
			const atExactBoundary = pos.col === line.length && line.length > 0 && line.length % available === 0;
			for (let w = 0; w < wrappedCount; w++) {
				const chunkStart = w * available;
				if (logRow === pos.row && pos.col >= chunkStart && !atExactBoundary && (w === wrappedCount - 1 || pos.col < chunkStart + available)) {
					return visualRow;
				}
				visualRow += 1;
			}
			// When the cursor is at the exact end of a line that fills the width,
			// it belongs on a new empty visual line past the last chunk.
			if (logRow === pos.row && atExactBoundary) return visualRow;
		}

		return Math.max(0, allVisual.length - 1);
	}

	private computeCursorScreenCol(width: number, firstPrefix: string, continuationPrefix: string): number {
		const pos = this.offsetToRowCol(this._cursor);
		const prefixLen = pos.row === 0 ? firstPrefix.length : continuationPrefix.length;
		const available = Math.max(1, width - prefixLen);
		const colInChunk = available > 0 ? pos.col % available : pos.col;
		return prefixLen + colInChunk + 1;
	}

	private cursorAtExactWrapBoundary(width: number, firstPrefix: string, continuationPrefix: string): boolean {
		const pos = this.offsetToRowCol(this._cursor);
		const logicalLines = this.logicalLines();
		const line = logicalLines[pos.row] ?? "";
		const prefixLen = pos.row === 0 ? firstPrefix.length : continuationPrefix.length;
		const available = Math.max(1, width - prefixLen);
		return pos.col === line.length && line.length > 0 && line.length % available === 0;
	}
}

// ── Utility ─────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeVirtualAttachmentTag(text: string, tag: string): string {
	const withTrailingSpace = `${tag} `;
	if (text.includes(withTrailingSpace)) return text.replace(withTrailingSpace, "");
	return text.replace(tag, "");
}

function suggestionSpansForChunk(
	chunkStart: number,
	chunkEnd: number,
	suggestionStart: number,
	suggestionEnd: number,
	prefixLength: number,
): Array<{ start: number; end: number }> | undefined {
	const start = Math.max(chunkStart, suggestionStart);
	const end = Math.min(chunkEnd, suggestionEnd);
	if (end <= start) return undefined;
	return [{ start: prefixLength + start - chunkStart, end: prefixLength + end - chunkStart }];
}
