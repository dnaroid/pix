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
import terminalBell from "../src/bundled-extensions/terminal-bell/index.js";

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

describe("bundled terminal-bell abort suppression", () => {
	type FakeCtx = {
		hasUI: false;
		cwd: string;
		sessionManager: {
			getSessionId: () => string;
			getSessionName?: () => string;
			getSessionFile?: () => string;
		};
		isIdle: () => boolean;
		hasPendingMessages: () => boolean;
	};

	type Handler = (event?: unknown, ctx?: unknown) => void | Promise<void>;

	interface Scenario {
		handlers: Record<string, Handler>;
		emit: (channel: string, data?: unknown) => void;
		attentionEvents: Array<{ cwd: string; sessionFile: string; sessionId: string }>;
		ctx: FakeCtx;
		flush: () => Promise<void>;
	}

	const BELL_TEST_ENV: Array<[string, string | undefined]> = [
		["HEADLESS", undefined],
		["PI_TERMINAL_BELL_DISABLED", undefined],
		["PI_TERMINAL_BELL_DELAY_MS", "0"],
		["PI_TERMINAL_BELL_SOUND", "0"],
		["PI_TERMINAL_BELL_NOTIFY", "0"],
		["PI_TERMINAL_BELL_TELEGRAM", "0"],
	];

	async function runScenario(fn: (scenario: Scenario) => Promise<void>): Promise<void> {
		const restore: Array<[string, string | undefined]> = [];
		for (const [name, value] of BELL_TEST_ENV) {
			restore.push([name, process.env[name]]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		try {
			const handlers: Record<string, Handler> = {};
			const eventHandlers: Record<string, (data?: unknown) => void> = {};
			const attentionEvents: Scenario["attentionEvents"] = [];
			const ctx: FakeCtx = {
				hasUI: false,
				cwd: "/test/cwd",
				sessionManager: {
					getSessionId: () => "session-abc",
					getSessionName: () => "test session",
					getSessionFile: () => "/test/session.json",
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			};
			const fakePi = {
				on: (channel: string, handler: Handler) => {
					handlers[channel] = handler;
				},
				events: {
					on: (channel: string, handler: (data?: unknown) => void) => {
						eventHandlers[channel] = handler;
					},
					emit: (channel: string, data?: unknown) => {
						if (channel === "pix:terminal-bell:attention") {
							attentionEvents.push(data as Scenario["attentionEvents"][number]);
						}
						eventHandlers[channel]?.(data);
					},
				},
				getSessionName: () => "test session",
			};

			terminalBell(fakePi as unknown as Parameters<typeof terminalBell>[0]);

			await fn({
				handlers,
				emit: (channel, data) => eventHandlers[channel]?.(data),
				attentionEvents,
				ctx,
				async flush() {
					// idleDelayMs is 0, so the bell timer fires on the next macrotask.
					await new Promise<void>((resolve) => setTimeout(resolve, 20));
				},
			});
		} finally {
			for (const [name, previous] of restore) {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			}
		}
	}

	it("does not ring when the SDK reports an aborted message_update", async () => {
		await runScenario(async ({ handlers, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.message_update?.({ assistantMessageEvent: { type: "error", reason: "aborted" } }, ctx);
			await handlers.agent_end?.({}, ctx);
			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 0);
		});
	});

	it("does not ring when the renderer relays pix:session-aborted before the bell fires", async () => {
		await runScenario(async ({ handlers, emit, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.agent_end?.({}, ctx);
			emit("pix:session-aborted", { aborted: true });
			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 0);
		});
	});

	it("rings once only after a normal completion settles", async () => {
		await runScenario(async ({ handlers, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.agent_end?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 0);
			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 1);
		});
	});

	it("rings once on a real error (reason: error) message_update", async () => {
		await runScenario(async ({ handlers, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.message_update?.(
				{ assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "boom" } } },
				ctx,
			);
			await handlers.agent_end?.({}, ctx);
			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 1);
		});
	});

	it("resets the abort flag on the next agent_start", async () => {
		await runScenario(async ({ handlers, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.message_update?.({ assistantMessageEvent: { type: "error", reason: "aborted" } }, ctx);
			await handlers.agent_end?.({}, ctx);
			await handlers.agent_settled?.({}, ctx);
			await flush();
			await handlers.agent_start?.({}, ctx);
			await handlers.agent_end?.({}, ctx);
			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 1);
		});
	});

	it("does not ring between retry or continuation attempts", async () => {
		await runScenario(async ({ handlers, attentionEvents, ctx, flush }) => {
			await handlers.agent_start?.({}, ctx);
			await handlers.message_update?.(
				{ assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "transient" } } },
				ctx,
			);
			await handlers.agent_end?.({ willRetry: true }, ctx);
			await flush();
			assert.equal(attentionEvents.length, 0);

			await handlers.agent_start?.({}, ctx);
			await handlers.message_update?.({ assistantMessageEvent: { type: "text_delta", delta: "done" } }, ctx);
			await handlers.agent_end?.({ willRetry: false }, ctx);
			await flush();
			assert.equal(attentionEvents.length, 0);

			await handlers.agent_settled?.({}, ctx);
			await flush();
			assert.equal(attentionEvents.length, 1);
		});
	});
});

