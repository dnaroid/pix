import { InputEditor } from "../../input-editor.js";
import { InputPasteHandler } from "./input-paste-handler.js";
import { hasTerminalCommandModifier, isNativeCommandPressed, isNativeShiftPressed } from "./native-modifiers.js";
import {
	parseTerminalEditShortcutSequence,
	parseTerminalInterruptSequence,
	parseTerminalModifiedKeySequence,
	terminalKeyArrowDirection,
	terminalEditShortcutForControlChar,
	terminalKeyIsClipboardImagePaste,
	terminalKeyIsShiftEnter,
	terminalKeyShouldIgnore,
} from "./terminal-edit-shortcuts.js";
import type { ExtensionTerminalInputResult } from "../extensions/extension-ui-controller.js";
import type { MouseEvent, ActivePopupMenu } from "../types.js";

type DirectPopupMenu = Exclude<ActivePopupMenu, "slash">;

const SHIFT_ENTER_ESCAPE_SEQUENCES = ["\x1b\r", "\x1b\n"];

export type InputControllerHost = {
	readonly inputEditor: InputEditor;
	readonly cwd: string;
	handleExtensionTerminalInput(data: string): ExtensionTerminalInputResult;
	extensionInputUsesEditor?(): boolean;
	isShiftPressed?(): boolean;
	getInput(): string;
	getDirectPopupMenu(): DirectPopupMenu | undefined;
	resetRequestHistoryNavigation(): void;
	resetInputMenuDismissals(): void;
	render(): void;
	moveActivePopupMenuSelection(delta: number): boolean;
	navigateRequestHistory(delta: number): boolean;
	scrollByLines(delta: number): void;
	scrollByPage(delta: number): void;
	handleMouse(event: MouseEvent): void;
	handleEnter(): void;
	handleInterrupt(): Promise<void>;
	handleEscape(): Promise<void>;
	handleDirectPopupInput(char: string): boolean;
	autocompleteModel(): boolean;
	autocompleteThinking(): boolean;
	acceptAutocompleteSuggestion(): boolean;
	autocompleteSlashCommand(): void;
	toggleVoiceRecording(): void;
	stop(): Promise<void>;
};

export class AppInputController {
	private inputBuffer = "";
	private readonly pasteHandler: InputPasteHandler;

	constructor(private readonly host: InputControllerHost) {
		this.pasteHandler = new InputPasteHandler(host);
	}

	handleChunk(chunk: Buffer): void {
		let data = chunk.toString("utf8");
		if (this.inputBuffer.startsWith("\x1b[<") || data.startsWith("\x1b[<")) {
			this.inputBuffer += data;
			this.drainInputBuffer();
			return;
		}
		if (this.consumeSharedEditorInput(data)) return;
		const extensionInput = this.host.handleExtensionTerminalInput(data);
		if (extensionInput.consume) return;
		if (extensionInput.data !== undefined) data = extensionInput.data;
		if (this.pasteHandler.handlePlainData(data)) return;

		this.inputBuffer += data;
		this.drainInputBuffer();
	}

	private consumeSharedEditorInput(data: string): boolean {
		if (this.host.extensionInputUsesEditor?.() !== true) return false;
		if (this.host.inputEditor.isInBracketedPaste) return false;

		if (data === "\n") {
			this.insertInputNewline();
			return true;
		}

		if (data === "\r" && this.isShiftPressed()) {
			this.insertInputNewline();
			return true;
		}

		if (SHIFT_ENTER_ESCAPE_SEQUENCES.includes(data)) {
			this.insertInputNewline();
			return true;
		}

		if (data === "\x16") {
			void this.pasteHandler.handleClipboardImagePaste();
			return true;
		}

		const modifiedKey = parseTerminalModifiedKeySequence(data);
		if (modifiedKey.kind !== "key") return false;
		if (terminalKeyShouldIgnore(modifiedKey.key)) return true;
		if (terminalKeyIsShiftEnter(modifiedKey.key)) {
			this.insertInputNewline();
			return true;
		}
		if (terminalKeyIsClipboardImagePaste(modifiedKey.key)) {
			void this.pasteHandler.handleClipboardImagePaste();
			return true;
		}

		return false;
	}

	private drainInputBuffer(): void {
		while (this.inputBuffer.length > 0) {
			if (this.consumeBracketedPastePayload()) continue;

			const mouseMatch = /^\x1b\[<(\d+);(-?\d+);(-?\d+)([mM])/.exec(this.inputBuffer);
			if (mouseMatch) {
				this.inputBuffer = this.inputBuffer.slice(mouseMatch[0].length);
				this.host.handleMouse({
					button: Number(mouseMatch[1]),
					x: Number(mouseMatch[2]),
					y: Number(mouseMatch[3]),
					released: mouseMatch[4] === "m",
				});
				continue;
			}

			if (this.inputBuffer.startsWith("\x1b[<")) return;
			const commandBackspaceSequence = this.consumeCommandBackspaceSequence();
			if (commandBackspaceSequence === "consumed") continue;
			if (commandBackspaceSequence === "pending") return;
			const commandArrowPageSequence = this.consumeCommandArrowPageSequence();
			if (commandArrowPageSequence === "consumed") continue;
			if (commandArrowPageSequence === "pending") return;
			const terminalInterruptSequence = this.consumeTerminalInterruptSequence();
			if (terminalInterruptSequence === "consumed") continue;
			if (terminalInterruptSequence === "pending") return;
			const shiftEnterSequence = this.consumeShiftEnterSequence();
			if (shiftEnterSequence === "consumed") continue;
			if (shiftEnterSequence === "pending") return;
			const clipboardImagePasteSequence = this.consumeClipboardImagePasteSequence();
			if (clipboardImagePasteSequence === "consumed") continue;
			if (clipboardImagePasteSequence === "pending") return;
			const terminalEditShortcutSequence = this.consumeTerminalEditShortcutSequence();
			if (terminalEditShortcutSequence === "consumed") continue;
			if (terminalEditShortcutSequence === "pending") return;
			const modifiedArrowKeySequence = this.consumeModifiedArrowKeySequence();
			if (modifiedArrowKeySequence === "consumed") continue;
			if (modifiedArrowKeySequence === "pending") return;
			const ignoredModifiedKeySequence = this.consumeIgnoredModifiedKeySequence();
			if (ignoredModifiedKeySequence === "consumed") continue;
			if (ignoredModifiedKeySequence === "pending") return;
			if (this.consumeEscapeSequence()) continue;
			if (this.isPendingEscapeSequence()) return;

			const char = this.inputBuffer[0];
			this.inputBuffer = this.inputBuffer.slice(1);
			if (char) this.handleChar(char);
		}
	}

	private consumeBracketedPastePayload(): boolean {
		if (!this.host.inputEditor.isInBracketedPaste) return false;

		const endSequence = "\x1b[201~";
		const endIndex = this.inputBuffer.indexOf(endSequence);
		if (endIndex === 0) return false;

		const payloadEnd = endIndex === -1
			? safeBracketedPastePayloadLength(this.inputBuffer, endSequence)
			: endIndex;
		if (payloadEnd === 0) return false;

		const payload = this.inputBuffer.slice(0, payloadEnd);
		this.inputBuffer = this.inputBuffer.slice(payloadEnd);
		this.pasteHandler.appendBracketedPasteText(normalizeBracketedPastePayload(payload));
		return true;
	}

	private getEscapeSequences(): Array<[string, () => void]> {
		return [
			...SHIFT_ENTER_ESCAPE_SEQUENCES.map((sequence) => [sequence, () => this.insertInputNewline()] as [string, () => void]),
			["\x1b[13u", () => this.host.handleEnter()],
			["\x1b[13;1u", () => this.host.handleEnter()],
			["\x1b[5~", () => this.host.scrollByPage(-1)],
			["\x1b[6~", () => this.host.scrollByPage(1)],
			["\x1b[A", () => this.handleArrowUp()],
			["\x1b[B", () => this.handleArrowDown()],
			["\x1b[C", () => this.handleArrowRight()],
			["\x1b[D", () => this.handleArrowLeft()],
			["\x1b[1;2A", () => { this.host.inputEditor.moveUpExtend(); this.host.render(); }],
			["\x1b[1;2B", () => { this.host.inputEditor.moveDownExtend(); this.host.render(); }],
			["\x1b[1;2C", () => { this.host.inputEditor.moveRightExtend(); this.host.render(); }],
			["\x1b[1;2D", () => { this.host.inputEditor.moveLeftExtend(); this.host.render(); }],
			["\x1b[H", () => { this.host.inputEditor.moveToLineStart(); this.host.render(); }],
			["\x1b[F", () => { this.host.inputEditor.moveToLineEnd(); this.host.render(); }],
			["\x1b[1~", () => { this.host.inputEditor.moveToLineStart(); this.host.render(); }],
			["\x1b[4~", () => { this.host.inputEditor.moveToLineEnd(); this.host.render(); }],
			["\x1b[1;5H", () => { this.host.inputEditor.moveToStart(); this.host.render(); }],
			["\x1b[1;5F", () => { this.host.inputEditor.moveToEnd(); this.host.render(); }],
			["\x1b[3~", () => { this.host.resetRequestHistoryNavigation(); this.host.inputEditor.deleteForward(); this.host.render(); }],
			["\x1b[1;3D", () => { this.host.inputEditor.moveWordLeft(); this.host.render(); }],
			["\x1b[1;3C", () => { this.host.inputEditor.moveWordRight(); this.host.render(); }],
			["\x1bb", () => { this.host.inputEditor.moveWordLeft(); this.host.render(); }],
			["\x1bf", () => { this.host.inputEditor.moveWordRight(); this.host.render(); }],
			["\x1b[3;3~", () => { this.host.resetRequestHistoryNavigation(); this.host.inputEditor.deleteWordForward(); this.host.render(); }],
			["\x1b[200~", () => this.pasteHandler.beginBracketedPaste()],
			["\x1b[201~", () => this.pasteHandler.endBracketedPaste()],
			["\x1b[1;2H", () => { this.host.inputEditor.moveToLineStartExtend(); this.host.render(); }],
			["\x1b[1;2F", () => { this.host.inputEditor.moveToLineEndExtend(); this.host.render(); }],
			["\x1b[122;9u", () => this.undoInput()],
			["\x1b[27;9;122~", () => this.undoInput()],
			["\x1b[90;10u", () => this.redoInput()],
			["\x1b[122;10u", () => this.redoInput()],
			["\x1b[27;10;90~", () => this.redoInput()],
			["\x1b[27;10;122~", () => this.redoInput()],
			["\x1b[121;9u", () => this.redoInput()],
			["\x1b[27;9;121~", () => this.redoInput()],
			["\x1b[97;5u", () => { this.host.inputEditor.selectAll(); this.host.render(); }],
			["\x1b[107;5u", () => this.deleteCurrentInputLine()],
		];
	}

	private isPendingEscapeSequence(): boolean {
		return this.inputBuffer.length > 1 && this.getEscapeSequences().some(([sequence]) => sequence.startsWith(this.inputBuffer));
	}

	private consumeEscapeSequence(): boolean {
		const sequences = this.getEscapeSequences();

		for (const [sequence, handler] of sequences) {
			if (this.inputBuffer.startsWith(sequence)) {
				this.inputBuffer = this.inputBuffer.slice(sequence.length);
				handler();
				return true;
			}
		}

		if (this.inputBuffer.startsWith("\x1b") && this.inputBuffer.length < 6) return false;
		if (this.inputBuffer.startsWith("\x1b")) {
			this.inputBuffer = this.inputBuffer.slice(1);
			return true;
		}
		return false;
	}

	private consumeCommandBackspaceSequence(): "consumed" | "pending" | "none" {
		if (!this.inputBuffer.startsWith("\x1b[")) return "none";

		const match = /^\x1b\[(?:(?:8|127);(\d+)u|27;(\d+);(?:8|127)~)/.exec(this.inputBuffer);
		if (match) {
			const modifierValue = Number(match[1] ?? match[2]);
			this.inputBuffer = this.inputBuffer.slice(match[0].length);

			if (!hasTerminalCommandModifier(modifierValue)) {
				this.host.resetRequestHistoryNavigation();
				this.host.inputEditor.deleteBackward();
				this.host.render();
				return "consumed";
			}

			this.deleteCurrentInputLine();
			return "consumed";
		}

		if (/^\x1b\[(?:8|127);\d*$/.test(this.inputBuffer)) return "pending";
		if (this.inputBuffer.startsWith("\x1b[27;") && !this.inputBuffer.includes("~")) return "pending";
		return "none";
	}

	private consumeCommandArrowPageSequence(): "consumed" | "pending" | "none" {
		if (!this.inputBuffer.startsWith("\x1b[")) return "none";

		const legacyMatch = /^\x1b\[1;(\d+)([AB])/.exec(this.inputBuffer);
		if (legacyMatch) return this.consumeCommandArrowPageMatch(legacyMatch[0].length, Number(legacyMatch[1]), legacyMatch[2]);

		const xtermMatch = /^\x1b\[27;(\d+);(65|66)~/.exec(this.inputBuffer);
		if (xtermMatch) return this.consumeCommandArrowPageMatch(xtermMatch[0].length, Number(xtermMatch[1]), xtermMatch[2] === "65" ? "A" : "B");

		if (/^\x1b\[1;\d*$/.test(this.inputBuffer)) return "pending";
		if (/^\x1b\[27;\d*(?:;\d*)?$/.test(this.inputBuffer)) return "pending";
		return "none";
	}

	private consumeCommandArrowPageMatch(length: number, modifierValue: number, arrow: string | undefined): "consumed" | "none" {
		if (!hasTerminalCommandModifier(modifierValue)) return "none";

		this.inputBuffer = this.inputBuffer.slice(length);
		this.host.scrollByPage(arrow === "A" ? -1 : 1);
		return "consumed";
	}

	private consumeTerminalEditShortcutSequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalEditShortcutSequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";

		this.inputBuffer = this.inputBuffer.slice(result.length);
		if (result.kind === "shortcut") {
			if (result.shortcut === "undo") this.undoInput();
			else this.redoInput();
		}
		return "consumed";
	}

	private consumeIgnoredModifiedKeySequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalModifiedKeySequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";
		if (!terminalKeyShouldIgnore(result.key)) return "none";

		this.inputBuffer = this.inputBuffer.slice(result.key.length);
		return "consumed";
	}

	private consumeModifiedArrowKeySequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalModifiedKeySequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";

		const direction = terminalKeyArrowDirection(result.key);
		if (!direction) return "none";

		this.inputBuffer = this.inputBuffer.slice(result.key.length);
		if (terminalKeyShouldIgnore(result.key)) return "consumed";

		if (direction === "up") this.handleArrowUp();
		else if (direction === "down") this.handleArrowDown();
		else if (direction === "right") this.handleArrowRight();
		else this.handleArrowLeft();
		return "consumed";
	}

	private consumeClipboardImagePasteSequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalModifiedKeySequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";
		if (!terminalKeyIsClipboardImagePaste(result.key)) return "none";

		this.inputBuffer = this.inputBuffer.slice(result.key.length);
		if (!terminalKeyShouldIgnore(result.key)) void this.pasteHandler.handleClipboardImagePaste();
		return "consumed";
	}

	private consumeShiftEnterSequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalModifiedKeySequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";
		if (!terminalKeyIsShiftEnter(result.key)) return "none";

		this.inputBuffer = this.inputBuffer.slice(result.key.length);
		if (!terminalKeyShouldIgnore(result.key)) this.insertInputNewline();
		return "consumed";
	}

	private consumeTerminalInterruptSequence(): "consumed" | "pending" | "none" {
		const result = parseTerminalInterruptSequence(this.inputBuffer);
		if (result.kind === "pending") return "pending";
		if (result.kind === "none") return "none";

		this.inputBuffer = this.inputBuffer.slice(result.length);
		void this.host.handleInterrupt();
		return "consumed";
	}

	private handleArrowUp(): void {
		if (isNativeCommandPressed()) {
			this.host.scrollByPage(-1);
			return;
		}
		if (this.host.moveActivePopupMenuSelection(-1)) return;
		if (this.host.getInput().includes("\n")) {
			const pos = this.host.inputEditor.cursor;
			const beforeCursor = this.host.getInput().slice(0, pos);
			const lineIndex = beforeCursor.split("\n").length - 1;
			if (lineIndex > 0) {
				this.host.inputEditor.moveUp();
				this.host.render();
				return;
			}
		}
		if (this.host.navigateRequestHistory(-1)) return;
		this.host.scrollByLines(-1);
	}

	private handleArrowDown(): void {
		if (isNativeCommandPressed()) {
			this.host.scrollByPage(1);
			return;
		}
		if (this.host.moveActivePopupMenuSelection(1)) return;
		if (this.host.getInput().includes("\n")) {
			const pos = this.host.inputEditor.cursor;
			const beforeCursor = this.host.getInput().slice(0, pos);
			const lineIndex = beforeCursor.split("\n").length - 1;
			const totalLines = this.host.getInput().split("\n").length;
			if (lineIndex < totalLines - 1) {
				this.host.inputEditor.moveDown();
				this.host.render();
				return;
			}
		}
		if (this.host.navigateRequestHistory(1)) return;
		this.host.scrollByLines(1);
	}

	private handleArrowLeft(): void {
		if (this.host.inputEditor.hasSelection) {
			const [start] = this.orderedEditorSelection();
			this.host.inputEditor.clearSelection();
			this.host.inputEditor.setText(this.host.inputEditor.text, start);
			this.host.render();
			return;
		}
		if (this.host.inputEditor.cursor > 0) {
			this.host.inputEditor.moveLeft();
			this.host.render();
		}
	}

	private handleArrowRight(): void {
		if (this.host.inputEditor.hasSelection) {
			const [, end] = this.orderedEditorSelection();
			this.host.inputEditor.clearSelection();
			this.host.inputEditor.setText(this.host.inputEditor.text, end);
			this.host.render();
			return;
		}
		if (this.host.inputEditor.cursor < this.host.inputEditor.text.length) {
			this.host.inputEditor.moveRight();
			this.host.render();
		}
	}

	private orderedEditorSelection(): [number, number] {
		const sel = this.host.inputEditor.selection;
		if (!sel) return [this.host.inputEditor.cursor, this.host.inputEditor.cursor];
		return sel.anchor < sel.active ? [sel.anchor, sel.active] : [sel.active, sel.anchor];
	}

	private insertInputNewline(): void {
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.insert("\n");
		this.host.render();
	}

	private undoInput(): void {
		this.host.resetRequestHistoryNavigation();
		if (this.host.inputEditor.undo()) this.host.resetInputMenuDismissals();
		this.host.render();
	}

	private redoInput(): void {
		this.host.resetRequestHistoryNavigation();
		if (this.host.inputEditor.redo()) this.host.resetInputMenuDismissals();
		this.host.render();
	}

	private handleEditShortcutChar(char: string): boolean {
		const controlShortcut = terminalEditShortcutForControlChar(char, this.isShiftPressed());
		if (controlShortcut) {
			if (controlShortcut === "undo") this.undoInput();
			else this.redoInput();
			return true;
		}

		if (!isNativeCommandPressed()) return false;

		const lower = char.toLowerCase();
		if (lower === "z") {
			if (char === "Z" || this.isShiftPressed()) this.redoInput();
			else this.undoInput();
			return true;
		}

		if (lower === "y") {
			this.redoInput();
			return true;
		}

		return false;
	}

	private deleteCurrentInputLine(): void {
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor.deleteToLineStartOrPreviousLineEnd();
		this.host.render();
	}

	private handleChar(char: string): void {
		if (char === "\u0003") {
			void this.host.handleInterrupt();
			return;
		}
		if (char === "\x1b") {
			void this.host.handleEscape();
			return;
		}
		if (char === "\t") {
			if (this.host.getDirectPopupMenu() === "sdk-menu") return;
			if (this.host.acceptAutocompleteSuggestion()) return;
			if (this.host.autocompleteModel()) return;
			if (this.host.autocompleteThinking()) return;
			this.host.autocompleteSlashCommand();
			return;
		}
		if (!this.host.inputEditor.isInBracketedPaste && this.handleEditShortcutChar(char)) return;
		if (this.host.handleDirectPopupInput(char)) return;
		if (char === "\u0004" && this.host.getInput().length === 0) {
			void this.host.stop();
			return;
		}
		if (char === "\u000c") {
			this.host.render();
			return;
		}
		if (char === "\u0007") {
			this.host.toggleVoiceRecording();
			return;
		}
		if (char === "\n") {
			if (this.host.inputEditor.isInBracketedPaste) {
				this.pasteHandler.appendBracketedPasteText("\n");
				return;
			}
			this.insertInputNewline();
			return;
		}
		if (char === "\r") {
			if (this.host.inputEditor.isInBracketedPaste) {
				this.pasteHandler.appendBracketedPasteText("\n");
				return;
			}
			if (this.isShiftPressed()) {
				this.insertInputNewline();
				return;
			}
			this.host.handleEnter();
			return;
		}
		if (char === "\u0015" || ((char === "\u007f" || char === "\b") && isNativeCommandPressed())) {
			this.deleteCurrentInputLine();
			return;
		}
		if (char === "\x16") {
			void this.pasteHandler.handleClipboardImagePaste();
			return;
		}
		if (char === "\u007f" || char === "\b") {
			if (this.host.inputEditor.isInBracketedPaste) return;
			this.host.resetRequestHistoryNavigation();
			this.host.inputEditor.deleteBackward();
			this.host.render();
			return;
		}
		if (char >= " ") {
			if (this.host.inputEditor.isInBracketedPaste) {
				this.pasteHandler.appendBracketedPasteText(char);
			} else {
				this.host.resetRequestHistoryNavigation();
				this.host.inputEditor.insert(char);
			}
			this.host.render();
		}
	}

	private isShiftPressed(): boolean {
		return this.host.isShiftPressed?.() ?? isNativeShiftPressed();
	}

}

function normalizeBracketedPastePayload(payload: string): string {
	return payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function safeBracketedPastePayloadLength(buffer: string, endSequence: string): number {
	for (let length = Math.min(buffer.length, endSequence.length - 1); length > 0; length--) {
		if (endSequence.startsWith(buffer.slice(buffer.length - length))) return buffer.length - length;
	}
	return buffer.length;
}
