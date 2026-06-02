import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

import { APP_ICONS } from "../icons.js";

const TERMINAL_BELL_CONFIG_KEY = "terminalBell";
const SOUND_CONFIG_KEY = "sound";

export function getPiToolsSuiteUserConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readTerminalBellSoundEnabled(configPath = getPiToolsSuiteUserConfigPath()): boolean {
	if (!existsSync(configPath)) return true;

	try {
		const parsed = parseJsonc(readFileSync(configPath, "utf-8")) as unknown;
		if (!isRecord(parsed)) return true;
		const terminalBell = parsed[TERMINAL_BELL_CONFIG_KEY];
		if (!isRecord(terminalBell)) return true;
		return typeof terminalBell[SOUND_CONFIG_KEY] === "boolean" ? terminalBell[SOUND_CONFIG_KEY] : true;
	} catch {
		return true;
	}
}

export function writeTerminalBellSoundEnabled(enabled: boolean, configPath = getPiToolsSuiteUserConfigPath()): void {
	const original = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "{}\n";
	const edits = modify(original, [TERMINAL_BELL_CONFIG_KEY, SOUND_CONFIG_KEY], enabled, {
		formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
	});
	const updated = applyEdits(original, edits);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf-8");
}

export class TerminalBellSoundController {
	private enabled: boolean;

	constructor(private readonly configPath = getPiToolsSuiteUserConfigPath()) {
		this.enabled = readTerminalBellSoundEnabled(this.configPath);
	}

	statusWidgetText(): string {
		return this.enabled ? APP_ICONS.volumeHigh : APP_ICONS.volumeOff;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	toggle(): boolean {
		const nextEnabled = !this.enabled;
		writeTerminalBellSoundEnabled(nextEnabled, this.configPath);
		this.enabled = nextEnabled;
		return this.enabled;
	}
}
