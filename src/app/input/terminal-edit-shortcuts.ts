export type TerminalEditShortcut = "undo" | "redo";

export type ParsedTerminalModifiedKeyResult =
	| { readonly kind: "key"; readonly key: ParsedModifiedKey }
	| { readonly kind: "pending" }
	| { readonly kind: "none" };

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
const KEY_CODE_ENTER = 13;
const KEY_CODE_ESCAPE = 27;
const KEY_CODE_V = 118;
const KEY_CODE_Y = 121;
const KEY_CODE_Z = 122;
const CYRILLIC_SMALL_ES_CODE = 1089;
const CYRILLIC_CAPITAL_ES_CODE = 1057;
const CYRILLIC_SMALL_EM_CODE = 1084;
const CYRILLIC_CAPITAL_EM_CODE = 1052;
const KITTY_ARROW_CODEPOINTS = {
	A: -1,
	B: -2,
	C: -3,
	D: -4,
} as const;

const KITTY_CSI_U_SEQUENCE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u/;
const KITTY_ARROW_SEQUENCE = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])/;
const XTERM_MODIFY_OTHER_KEYS_SEQUENCE = /^\x1b\[27;(\d+);(\d+)~/;

interface ParsedModifiedKey {
	readonly codepoint: number;
	readonly baseLayoutKey: number | undefined;
	readonly modifier: number;
	readonly eventType: number | undefined;
	readonly length: number;
}

export function parseTerminalModifiedKeySequence(input: string): ParsedTerminalModifiedKeyResult {
	const kitty = parseKittyCsiUSequence(input);
	if (kitty) return { kind: "key", key: kitty };

	const kittyArrow = parseKittyArrowSequence(input);
	if (kittyArrow) return { kind: "key", key: kittyArrow };

	const xterm = parseXtermModifyOtherKeysSequence(input);
	if (xterm) return { kind: "key", key: xterm };

	if (isPotentialModifiedKeyPrefix(input)) return { kind: "pending" };
	return { kind: "none" };
}

export function parseTerminalEditShortcutSequence(input: string): TerminalEditShortcutSequenceResult {
	const result = parseTerminalModifiedKeySequence(input);
	if (result.kind === "pending") return { kind: "pending" };
	if (result.kind === "none") return { kind: "none" };
	return terminalEditShortcutResult(result.key);
}

export function parseTerminalInterruptSequence(input: string): { readonly kind: "interrupt"; readonly length: number } | { readonly kind: "pending" } | { readonly kind: "none" } {
	const result = parseTerminalModifiedKeySequence(input);
	if (result.kind === "pending") return { kind: "pending" };
	if (result.kind === "key" && terminalKeyIsControlC(result.key)) return { kind: "interrupt", length: result.key.length };

	if (result.kind === "key" || isPotentialInterruptPrefix(input)) return { kind: "none" };
	return { kind: "none" };
}

export function terminalKeyIsShiftEnter(key: ParsedModifiedKey): boolean {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if ((effectiveModifier & SHIFT_MODIFIER_FLAG) === 0) return false;
	return terminalKeyMatchesCodepoint(key, KEY_CODE_ENTER);
}

export function terminalKeyIsClipboardImagePaste(key: ParsedModifiedKey): boolean {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if ((effectiveModifier & (CONTROL_MODIFIER_FLAG | COMMAND_MODIFIER_FLAG)) === 0) return false;
	return terminalKeyMatchesCodepoint(key, KEY_CODE_V, CYRILLIC_SMALL_EM_CODE, CYRILLIC_CAPITAL_EM_CODE);
}

export function terminalKeyShouldIgnore(key: ParsedModifiedKey): boolean {
	return key.eventType === 3;
}

export function terminalKeyIsEscape(key: ParsedModifiedKey): boolean {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if (effectiveModifier !== 0) return false;
	return key.codepoint === KEY_CODE_ESCAPE;
}

export function terminalKeyArrowDirection(key: ParsedModifiedKey): "up" | "down" | "right" | "left" | undefined {
	const effectiveModifier = key.modifier & ~LOCK_MODIFIER_MASK;
	if (effectiveModifier !== 0) return undefined;

	if (key.codepoint === KITTY_ARROW_CODEPOINTS.A) return "up";
	if (key.codepoint === KITTY_ARROW_CODEPOINTS.B) return "down";
	if (key.codepoint === KITTY_ARROW_CODEPOINTS.C) return "right";
	if (key.codepoint === KITTY_ARROW_CODEPOINTS.D) return "left";
	return undefined;
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

function parseKittyArrowSequence(input: string): ParsedModifiedKey | undefined {
	const match = KITTY_ARROW_SEQUENCE.exec(input);
	if (!match) return undefined;

	const modifierValue = Number.parseInt(match[1] ?? "", 10);
	const eventType = match[2] ? Number.parseInt(match[2], 10) : undefined;
	const arrow = match[3] as keyof typeof KITTY_ARROW_CODEPOINTS | undefined;
	const codepoint = arrow ? KITTY_ARROW_CODEPOINTS[arrow] : undefined;

	if (!Number.isFinite(modifierValue) || codepoint === undefined) return undefined;
	return {
		codepoint,
		baseLayoutKey: undefined,
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

function terminalKeyMatchesCodepoint(key: ParsedModifiedKey, ...expectedCodepoints: number[]): boolean {
	return expectedCodepoints.some((codepoint) => keyMatchesCodepoint(key, codepoint));
}

function keyMatchesCodepoint(key: ParsedModifiedKey, expectedCodepoint: number): boolean {
	const normalizedExpected = normalizeLetterCodepoint(expectedCodepoint);
	const primary = normalizeLetterCodepoint(key.codepoint);
	if (primary === normalizedExpected) return true;

	const baseLayout = key.baseLayoutKey;
	return baseLayout !== undefined && normalizeLetterCodepoint(baseLayout) === normalizedExpected;
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

function isPotentialModifiedKeyPrefix(input: string): boolean {
	if (!input.startsWith("\x1b[")) return false;
	if (input.includes("u") || input.includes("~")) return false;

	const body = input.slice(2);
	return /^[\d:;]*$/.test(body);
}

function isPotentialInterruptPrefix(input: string): boolean {
	if (!input.startsWith("\x1b[")) return false;
	if (input.includes("u") || input.includes("~")) return false;

	const body = input.slice(2);
	if (!/^[\d:;]*$/.test(body)) return false;

	const possibleStarts = ["99", "67", "1089", "1057", "27;"];
	return possibleStarts.some((start) => start.startsWith(body) || body.startsWith(start));
}
