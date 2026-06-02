import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canRingTerminal, readTerminalBellSoundConfig, terminalBellNotificationsEnabled, terminalBellSoundEnabled } from "../src/terminal-bell/index";

describe("terminal-bell config", () => {
	test("reads terminalBell.sound from jsonc", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{
			// persisted by the pix status-bar sound toggle
			"terminalBell": { "sound": false }
		}\n`, "utf-8");

		expect(readTerminalBellSoundConfig(configPath)).toBe(false);
	});

	test("treats a missing setting as undefined", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{"terminalBell": {}}\n`, "utf-8");

		expect(readTerminalBellSoundConfig(configPath)).toBeUndefined();
	});

	test("uses terminalBell.sound for all audible bell output", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{"terminalBell": { "sound": false }}\n`, "utf-8");

		const muted = withEnv("PI_TERMINAL_BELL_SOUND", undefined, () => terminalBellSoundEnabled({ hasUI: true }, configPath));
		const forcedRing = withEnv("PI_TERMINAL_BELL_SOUND", undefined, () =>
			withEnv("PI_TERMINAL_BELL_FORCE", "1", () => canRingTerminal({ hasUI: true }, configPath)),
		);

		expect(muted).toBe(false);
		expect(forcedRing).toBe(false);
	});

	test("uses terminalBell.sound for system notifications on every notification backend", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{"terminalBell": { "sound": false }}\n`, "utf-8");

		const muted = withEnv("PI_TERMINAL_BELL_SOUND", undefined, () =>
			withEnv("PI_TERMINAL_BELL_NOTIFY", undefined, () => terminalBellNotificationsEnabled({ hasUI: true }, configPath)),
		);
		const forcedNotify = withEnv("PI_TERMINAL_BELL_SOUND", undefined, () =>
			withEnv("PI_TERMINAL_BELL_NOTIFY", "1", () => terminalBellNotificationsEnabled({ hasUI: true }, configPath)),
		);

		expect(muted).toBe(false);
		expect(forcedNotify).toBe(false);
	});

	test("keeps PI_TERMINAL_BELL_NOTIFY as a notification-only override when the shared toggle is enabled", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{"terminalBell": { "sound": true }}\n`, "utf-8");

		expect(withEnv("PI_TERMINAL_BELL_NOTIFY", "0", () => terminalBellNotificationsEnabled({ hasUI: true }, configPath))).toBe(false);
		expect(withEnv("PI_TERMINAL_BELL_NOTIFY", "1", () => terminalBellNotificationsEnabled({ hasUI: false }, configPath))).toBe(true);
	});

	test("lets PI_TERMINAL_BELL_SOUND override the jsonc sound toggle", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		writeFileSync(configPath, `{"terminalBell": { "sound": false }}\n`, "utf-8");

		expect(withEnv("PI_TERMINAL_BELL_SOUND", "1", () => terminalBellSoundEnabled({ hasUI: true }, configPath))).toBe(true);
		expect(withEnv("PI_TERMINAL_BELL_SOUND", "1", () => terminalBellNotificationsEnabled({ hasUI: true }, configPath))).toBe(true);
	});
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-suite-terminal-bell-"));
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
}
