import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { canRingTerminal, readTerminalBellSoundConfig, terminalBellNotificationsEnabled, terminalBellSoundEnabled } from "../extensions/terminal-bell/index.js";

describe("bundled terminal-bell config", () => {
	it("reads terminalBell.sound from the shared pi-tools-suite jsonc config", () => {
		withTempConfig(`{
			// persisted by the status-line bell icon
			"terminalBell": { "sound": false }
		}
		`, (configPath) => {
			assert.equal(readTerminalBellSoundConfig(configPath), false);
		});
	});

	it("uses terminalBell.sound for all bundled audible bell output", () => {
		withTempConfig(`{"terminalBell": { "sound": false }}\n`, (configPath) => {
			assert.equal(withEnv("PI_TERMINAL_BELL_SOUND", undefined, () => terminalBellSoundEnabled({ hasUI: true }, configPath)), false);
			assert.equal(
				withEnv("PI_TERMINAL_BELL_SOUND", undefined, () =>
					withEnv("PI_TERMINAL_BELL_FORCE", "1", () => canRingTerminal({ hasUI: true }, configPath)),
				),
				false,
			);
		});
	});

	it("uses terminalBell.sound for bundled system notifications", () => {
		withTempConfig(`{"terminalBell": { "sound": false }}\n`, (configPath) => {
			assert.equal(
				withEnv("PI_TERMINAL_BELL_SOUND", undefined, () =>
					withEnv("PI_TERMINAL_BELL_NOTIFY", "1", () => terminalBellNotificationsEnabled({ hasUI: true }, configPath)),
				),
				false,
			);
		});
	});

	it("lets PI_TERMINAL_BELL_SOUND override bundled jsonc mute", () => {
		withTempConfig(`{"terminalBell": { "sound": false }}\n`, (configPath) => {
			assert.equal(withEnv("PI_TERMINAL_BELL_SOUND", "1", () => terminalBellSoundEnabled({ hasUI: true }, configPath)), true);
			assert.equal(withEnv("PI_TERMINAL_BELL_SOUND", "1", () => terminalBellNotificationsEnabled({ hasUI: true }, configPath)), true);
		});
	});
});

function withTempConfig<T>(content: string, fn: (configPath: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pix-terminal-bell-"));
	try {
		const configPath = join(dir, "pi-tools-suite.jsonc");
		writeFileSync(configPath, content, "utf-8");
		return fn(configPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[name];
	try {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		return fn();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}
