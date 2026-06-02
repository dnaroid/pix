import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_COMMAND_MODIFIER_FLAG } from "../constants.js";
import type { NativeModifierKey, NativeModifiersHelper } from "../types.js";
import { isRecord } from "../guards.js";

const cjsRequire = createRequire(import.meta.url);
let nativeModifiersHelper: NativeModifiersHelper | null | undefined;

export function isNativeShiftPressed(): boolean {
	return isNativeModifierPressed("shift");
}

export function isNativeCommandPressed(): boolean {
	return isNativeModifierPressed("command");
}

function isNativeModifierPressed(key: NativeModifierKey): boolean {
	const helper = loadNativeModifiersHelper();
	if (!helper) return false;

	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}

export function hasTerminalCommandModifier(modifierValue: number): boolean {
	return ((modifierValue - 1) & TERMINAL_COMMAND_MODIFIER_FLAG) !== 0;
}

function loadNativeModifiersHelper(): NativeModifiersHelper | undefined {
	if (nativeModifiersHelper !== undefined) return nativeModifiersHelper ?? undefined;
	nativeModifiersHelper = null;

	if (process.platform !== "darwin") return undefined;
	if (process.arch !== "x64" && process.arch !== "arm64") return undefined;

	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const nativePath = join("native", "darwin", "prebuilds", `darwin-${process.arch}`, "darwin-modifiers.node");
	const candidates = [
		join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", nativePath),
		join(process.cwd(), "node_modules", "@earendil-works", "pi-tui", nativePath),
		join(moduleDir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", nativePath),
		join(dirname(process.execPath), nativePath),
	];

	for (const candidate of candidates) {
		try {
			const helper = cjsRequire(candidate) as unknown;
			if (isNativeModifiersHelper(helper)) {
				nativeModifiersHelper = helper;
				return helper;
			}
		} catch {
			// Try the next possible install layout.
		}
	}

	return undefined;
}

function isNativeModifiersHelper(value: unknown): value is NativeModifiersHelper {
	return isRecord(value) && typeof value.isModifierPressed === "function";
}

