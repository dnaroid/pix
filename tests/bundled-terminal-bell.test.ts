import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	canRingTerminal,
	readTerminalBellSoundConfig,
	readTerminalBellTelegramConfig,
	resolveTerminalBellTelegramConfig,
	terminalBellNotificationsEnabled,
	terminalBellSoundEnabled,
	terminalBellTelegramEnabled,
} from "../src/bundled-extensions/terminal-bell/index.js";

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

describe("bundled terminal-bell telegram config", () => {
	it("reads terminalBell.telegram.botToken/chatId from the shared jsonc config", () => {
		withTempConfig(`{
			"terminalBell": {
				"telegram": {
					"botToken": "123:abc",
					"chatId": "42"
				}
			}
		}\n`, (configPath) => {
			assert.deepEqual(readTerminalBellTelegramConfig(configPath), { botToken: "123:abc", chatId: "42" });
			assert.deepEqual(resolveTerminalBellTelegramConfig(configPath), { botToken: "123:abc", chatId: "42" });
			assert.equal(terminalBellTelegramEnabled(configPath), true);
		});
	});

	it("trims configured values and drops empty strings", () => {
		withTempConfig(`{"terminalBell": { "telegram": { "botToken": "  ", "chatId": "  42  " } }}\n`, (configPath) => {
			assert.deepEqual(readTerminalBellTelegramConfig(configPath), { chatId: "42" });
			assert.equal(terminalBellTelegramEnabled(configPath), false);
		});
	});

	it("returns disabled when only one of token/chatId is set", () => {
		withTempConfig(`{"terminalBell": { "telegram": { "botToken": "123:abc" } }}\n`, (configPath) => {
			assert.equal(terminalBellTelegramEnabled(configPath), false);
		});
	});

	it("lets env override the configured botToken/chatId", () => {
		withTempConfig(`{"terminalBell": { "telegram": { "botToken": "123:abc", "chatId": "42" } }}\n`, (configPath) => {
			const resolved = withEnvChain(
				[["PI_TERMINAL_BELL_TELEGRAM_BOT_TOKEN", "999:zzz"], ["PI_TERMINAL_BELL_TELEGRAM_CHAT_ID", "77"]],
				() => resolveTerminalBellTelegramConfig(configPath),
			);
			assert.deepEqual(resolved, { botToken: "999:zzz", chatId: "77" });
		});
	});

	it("PI_TERMINAL_BELL_TELEGRAM=0 forces telegram off even when fully configured", () => {
		withTempConfig(`{"terminalBell": { "telegram": { "botToken": "123:abc", "chatId": "42" } }}\n`, (configPath) => {
			assert.equal(withEnv("PI_TERMINAL_BELL_TELEGRAM", "0", () => terminalBellTelegramEnabled(configPath)), false);
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

function withEnvChain<T>(entries: Array<[string, string | undefined]>, fn: () => T): T {
	const restore: Array<[string, string | undefined]> = [];
	for (const [name, value] of entries) {
		restore.push([name, process.env[name]]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return fn();
	} finally {
		for (const [name, previous] of restore) {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	}
}
