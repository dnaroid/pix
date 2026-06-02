export type TerminalEditShortcut = "undo" | "redo";

export type TerminalEditShortcutSequenceResult =
	| { readonly kind: "shortcut"; readonly shortcut: TerminalEditShortcut; readonly length: number }
	| { readonly kind: "ignore"; readonly length: number }
	| { readonly kind: "pending" }
	| { readonly kind: "none" };

const SHIFT_MODIFIER_FLAG = 1;
const CONTROL_MODIFIER_FLAG = 4;
const COMMAND_MODIFIER_FLAG = 8;
const LOCK_MODIFIER_MASK = 64 + 128;

const KEY_CODE_C = 99;
const KEY_CODE_Y = 121;
const KEY_CODE_Z = 122;
const CYRILLIC_SMALL_ES_CODE = 1089;
const CYRILLIC_CAPITAL_ES_CODE = 1057;

const KITTY_CSI_U_SEQUENCE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u/;
const XTERM_MODIFY_OTHER_KEYS_SEQUENCE = /^\x1b\[27;(\d+);(\d+)~/;

interface ParsedModifiedKey {
	readonly codepoint: number;
	readonly baseLayoutKey: number | undefined;
	readonly modifier: number;
	readonly eventType: number | undefined;
	readonly length: number;
}

export function parseTerminalEditShortcutSequence(input: string): TerminalEditShortcutSequenceResult {
	const kitty = parseKittyCsiUSequence(input);
	if (kitty) return terminalEditShortcutResult(kitty);

	const xterm = parseXtermModifyOtherKeysSequence(input);
	if (xterm) return terminalEditShortcutResult(xterm);

	if (isPotentialEditShortcutPrefix(input)) return { kind: "pending" };
	return { kind: "none" };
}

export function parseTerminalInterruptSequence(input: string): { readonly kind: "interrupt"; readonly length: number } | { readonly kind: "pending" } | { readonly kind: "none" } {
	const kitty = parseKittyCsiUSequence(input);
	if (kitty && terminalKeyIsControlC(kitty)) return { kind: "interrupt", length: kitty.length };

	const xterm = parseXtermModifyOtherKeysSequence(input);
	if (xterm && terminalKeyIsControlC(xterm)) return { kind: "interrupt", length: xterm.length };

	if (isPotentialInterruptPrefix(input)) return { kind: "pending" };
	return { kind: "none" };
}

export function terminalEditShortcutForControlChar(char: string, shiftPressed: boolean): TerminalEditShortcut | undefined {
	if (char === "\u001a") return shiftPressed ? "redo" : "undo";
	if (char === "\u0019") return "redo";
	return undefined;
}

function parseKittyCsiUSequence(input: string): ParsedModifiedKey | undefined {
	const match = KITTY_CSI_U_SEQUENCE.exec(input);
	if (!match) return undefined;

	const codepoint = Number.parseInt(match[1] ?? "", 10);
	const baseLayoutKey = match[3] ? Number.parseInt(match[3], 10) : undefined;
	const modifierValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	const eventType = match[5] ? Number.parseInt(match[5], 10) : undefined;

	if (!Number.isFinite(codepoint) || !Number.isFinite(modifierValue)) return undefined;
	return {
		codepoint,
		baseLayoutKey: Number.isFinite(baseLayoutKey) ? baseLayoutKey : undefined,
		modifier: modifierValue - 1,
		eventType: Number.isFinite(eventType) ? eventType : undefined,
		length: match[0].length,
	};
}

function parseXtermModifyOtherKeysSequence(input: string): ParsedModifiedKey | undefined {
	const match = XTERM_MODIFY_OTHER_KEYS_SEQUENCE.exec(input);
	if (!match) return undefined;

	const modifierValue = Number.parseInt(match[1] ?? "", 10);
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(codepoint) || !Number.isFinite(modifierValue)) return undefined;

	return {
		codepoint,
		baseLayoutKey: undefined,
		modifier: modifierValue - 1,
		eventType: undefined,
		length: match[0].length,
	};
}

function terminalEditShortcutResult(key: ParsedModifiedKey): TerminalEditShortcutSequenceResult {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if ((effectiveModifier & COMMAND_MODIFIER_FLAG) === 0) return { kind: "none" };

	// Kitty keyboard protocol flag 2 appends event types. Press/repeat are action-worthy;
	// release must be swallowed so the release packet is not inserted into the editor.
	if (key.eventType === 3) return { kind: "ignore", length: key.length };

	const shortcut = terminalEditShortcutForKey(key, effectiveModifier);
	if (!shortcut) return { kind: "ignore", length: key.length };
	return { kind: "shortcut", shortcut, length: key.length };
}

function terminalKeyIsControlC(key: ParsedModifiedKey): boolean {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if ((effectiveModifier & CONTROL_MODIFIER_FLAG) === 0) return false;
	return interruptCodepointIsC(key.codepoint) || interruptCodepointIsC(key.baseLayoutKey ?? key.codepoint);
}

function interruptCodepointIsC(codepoint: number): boolean {
	const normalized = normalizeLetterCodepoint(codepoint);
	return normalized === KEY_CODE_C || normalized === CYRILLIC_SMALL_ES_CODE || normalized === CYRILLIC_CAPITAL_ES_CODE;
}

function terminalEditShortcutForKey(key: ParsedModifiedKey, effectiveModifier: number): TerminalEditShortcut | undefined {
	const codepoint = editShortcutCodepoint(key);
	if (codepoint === KEY_CODE_Y) return "redo";
	if (codepoint !== KEY_CODE_Z) return undefined;

	return (effectiveModifier & SHIFT_MODIFIER_FLAG) !== 0 ? "redo" : "undo";
}

function editShortcutCodepoint(key: ParsedModifiedKey): number {
	const primary = normalizeLetterCodepoint(key.codepoint);
	if (primary === KEY_CODE_Z || primary === KEY_CODE_Y) return primary;

	return normalizeLetterCodepoint(key.baseLayoutKey ?? key.codepoint);
}

function normalizeLetterCodepoint(codepoint: number): number {
	if (codepoint >= 65 && codepoint <= 90) return codepoint + 32;
	return codepoint;
}

function isPotentialEditShortcutPrefix(input: string): boolean {
	if (!input.startsWith("\x1b[")) return false;
	if (input.includes("u") || input.includes("~")) return false;

	const body = input.slice(2);
	if (!/^[\d:;]*$/.test(body)) return false;

	const possibleStarts = ["122", "121", "90", "27;"];
	return possibleStarts.some((start) => start.startsWith(body) || body.startsWith(start));
}

function isPotentialInterruptPrefix(input: string): boolean {
	if (!input.startsWith("\x1b[")) return false;
	if (input.includes("u") || input.includes("~")) return false;

	const body = input.slice(2);
	if (!/^[\d:;]*$/.test(body)) return false;

	const possibleStarts = ["99", "67", "1089", "1057", "27;"];
	return possibleStarts.some((start) => start.startsWith(body) || body.startsWith(start));
}
