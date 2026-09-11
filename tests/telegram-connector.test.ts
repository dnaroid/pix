import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import questionExtension from "../src/bundled-extensions/question/index.js";
import { registerRemoteQuestionHandler } from "../src/bundled-extensions/question/remote.js";
import type { NormalizedQuestion, QuestionToolInput } from "../src/bundled-extensions/question/types.js";
import { TelegramBotClient, normalizeIncomingMessage, trimTelegramText, type TelegramIncomingMessage } from "../src/bundled-extensions/telegram-connector/bot.js";
import {
	readTelegramConnectorConfig,
	resolveTelegramConnectorConfig,
} from "../src/bundled-extensions/telegram-connector/config.js";
import {
	getTelegramConnectorCoordinator,
	parseQuestionAnswer,
	parseTelegramCommand,
	resetTelegramConnectorCoordinatorForTests,
	TelegramConnectorCoordinator,
	type TelegramSessionEndpoint,
} from "../src/bundled-extensions/telegram-connector/coordinator.js";
import telegramConnector, { assistantVisibleText } from "../src/bundled-extensions/telegram-connector/index.js";

describe("telegram connector config", () => {
	it("loads the dedicated connector block and accepts numeric chat ids", () => {
		withTempConfig(`{
			"telegramConnector": {
				"botToken": " 123:abc ",
				"chatId": -10042
			}
		}\n`, (configPath) => {
			assert.deepEqual(readTelegramConnectorConfig(configPath), {
				enabled: true,
				botToken: "123:abc",
				chatId: "-10042",
			});
		});
	});

	it("lets the dedicated env vars enable or disable the connector", () => {
		withTempConfig(`{"telegramConnector": {"enabled": false, "botToken": "config", "chatId": "1"}}\n`, (configPath) => {
			assert.deepEqual(resolveTelegramConnectorConfig(configPath, {
				PIX_TELEGRAM_CONNECTOR: "1",
				PIX_TELEGRAM_BOT_TOKEN: "env-token",
				PIX_TELEGRAM_CHAT_ID: "42",
			}), { enabled: true, botToken: "env-token", chatId: "42" });
			assert.equal(resolveTelegramConnectorConfig(configPath, {
				PIX_TELEGRAM_CONNECTOR: "0",
				PIX_TELEGRAM_BOT_TOKEN: "env-token",
				PIX_TELEGRAM_CHAT_ID: "42",
			}).enabled, false);
		});
	});

	it("enables from env credentials alone without a separate enable flag", () => {
		withTempConfig(`{}\n`, (configPath) => {
			assert.deepEqual(resolveTelegramConnectorConfig(configPath, {
				PIX_TELEGRAM_BOT_TOKEN: "env-token",
				PIX_TELEGRAM_CHAT_ID: "42",
			}), { enabled: true, botToken: "env-token", chatId: "42" });
		});
	});
});

describe("telegram connector protocol", () => {
	it("drops Telegram backlog when polling starts and only handles later updates", async () => {
		const offsets: Array<number | undefined> = [];
		let poll = 0;
		const client = new TelegramBotClient("secret-token", "42", (async (_url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: number };
			offsets.push(body.offset);
			poll += 1;
			const result = poll === 1
				? [{ update_id: 10, message: { message_id: 100, chat: { id: 42 }, text: "stale" } }]
				: [{ update_id: 11, message: { message_id: 101, chat: { id: 42 }, text: "fresh" } }];
			return {
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result }),
			} as Response;
		}) as typeof fetch);
		const received: TelegramIncomingMessage[] = [];
		const delivered = new Promise<void>((resolve) => {
			client.start((message) => {
				received.push(message);
				client.stop();
				resolve();
			});
		});

		await Promise.race([
			delivered,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("poll did not deliver fresh update")), 250)),
		]);

		assert.deepEqual(offsets.slice(0, 2), [-1, 11]);
		assert.deepEqual(received.map((message) => message.text), ["fresh"]);
	});

	it("redacts the bot token from polling errors", async () => {
		const token = "secret-token";
		const client = new TelegramBotClient(token, "42", (async () => {
			throw new Error(`request failed at https://api.telegram.org/bot${token}/getUpdates`);
		}) as typeof fetch);
		const reported = new Promise<string>((resolve) => {
			client.start(() => {}, (error) => {
				client.stop();
				resolve(error.message);
			});
		});

		const message = await Promise.race([
			reported,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("poll error was not reported")), 250)),
		]);
		assert.equal(message.includes(token), false);
		assert.match(message, /\[redacted\]/u);
	});

	it("bounds a stuck Telegram send so a remote question can fall back", async () => {
		const client = new TelegramBotClient("secret-token", "42", (async (_url, init) => {
			await new Promise<never>((_resolve, reject) => {
				const signal = init?.signal;
				assert.ok(signal);
				signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
			});
			throw new Error("unreachable");
		}) as typeof fetch, { sendTimeoutMs: 5 });

		await assert.rejects(client.sendMessage("hello"));
	});

	it("normalizes Telegram text updates and reply routing metadata", () => {
		assert.deepEqual(normalizeIncomingMessage({
			update_id: 9,
			message: {
				message_id: 10,
				chat: { id: -42 },
				text: "  continue  ",
				reply_to_message: { message_id: 7 },
			},
		}), {
			messageId: 10,
			chatId: "-42",
			text: "continue",
			replyToMessageId: 7,
		});
	});

	it("parses only the small public command surface", () => {
		assert.deepEqual(parseTelegramCommand("/new fix tests"), { kind: "new", task: "fix tests" });
		assert.deepEqual(parseTelegramCommand("/status@pix_bot"), { kind: "status" });
		assert.deepEqual(parseTelegramCommand("/help"), { kind: "help" });
		assert.deepEqual(parseTelegramCommand("/compact"), { kind: "message", text: "/compact" });
	});

	it("maps question replies to normalized single and multiple selections", () => {
		const single = normalizedQuestion();
		assert.deepEqual(parseQuestionAnswer(single, "2"), { id: "choice", choiceValue: "b" });
		assert.deepEqual(parseQuestionAnswer(single, "my answer"), { id: "choice", customText: "my answer" });

		const multiple: NormalizedQuestion = {
			...single,
			id: "multi",
			multiple: true,
			minSelections: 1,
			maxSelections: 2,
		};
		assert.deepEqual(parseQuestionAnswer(multiple, "1, 2"), { id: "multi", choiceValues: ["a", "b"] });
		assert.deepEqual(parseQuestionAnswer(multiple, "something else"), { id: "multi", choiceValues: [], customText: "something else" });
		assert.equal(parseQuestionAnswer(multiple, "1, 2, 3"), undefined);
	});

	it("keeps Telegram message bodies below the Bot API safety limit", () => {
		assert.equal(trimTelegramText("x".repeat(5000)).length, 3999);
	});
});

describe("telegram connector coordinator", () => {
	it("routes a reply to the exact session that emitted the notification", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const first = fakeEndpoint("session-a", "/repo/a");
		const second = fakeEndpoint("session-b", "/repo/b");
		coordinator.attachSession(first.endpoint, enabledConfig());
		coordinator.attachSession(second.endpoint, enabledConfig());

		await coordinator.notifyCompletion("session-a", "complete", "Done A");
		const firstNotification = bot.sent.at(-1)!;
		await coordinator.notifyCompletion("session-b", "complete", "Done B");

		await bot.receive({
			messageId: 300,
			chatId: "42",
			text: "continue A",
			replyToMessageId: firstNotification.messageId,
		});

		assert.deepEqual(first.userMessages, ["continue A"]);
		assert.deepEqual(second.userMessages, []);
		coordinator.stop();
	});

	it("turns /new into a short-lived request for the addressed source session", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		await coordinator.notifyCompletion("session-a", "complete");
		const notification = bot.sent.at(-1)!;

		await bot.receive({
			messageId: 301,
			chatId: "42",
			text: "/new implement feature B",
			replyToMessageId: notification.messageId,
		});

		assert.equal(session.newSessionRequestIds.length, 1);
		const requestId = session.newSessionRequestIds[0]!;
		assert.equal(coordinator.consumeNewSessionRequest(requestId, "session-a"), "implement feature B");
		assert.equal(coordinator.consumeNewSessionRequest(requestId, "session-a"), undefined);
		coordinator.stop();
	});

	it("resolves a pending question from a reply to that question message", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		const pending = coordinator.askQuestions("session-a", [normalizedQuestion()]);
		await nextMacrotask();
		const questionMessage = bot.sent.at(-1)!;

		await bot.receive({
			messageId: 302,
			chatId: "42",
			text: "2",
			replyToMessageId: questionMessage.messageId,
		});

		assert.deepEqual(await pending, [{ id: "choice", choiceValue: "b" }]);
		coordinator.stop();
	});

	it("keeps the question route armed while validation feedback is still sending", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		const pending = coordinator.askQuestions("session-a", [normalizedQuestion()]);
		await nextMacrotask();
		const questionMessage = bot.sent.at(-1)!;
		let releaseFeedback!: () => void;
		const feedbackGate = new Promise<void>((resolve) => {
			releaseFeedback = resolve;
		});
		let feedbackStartedResolve!: () => void;
		const feedbackStarted = new Promise<void>((resolve) => {
			feedbackStartedResolve = resolve;
		});
		bot.beforeSend = async (text) => {
			if (!text.startsWith("Не понял выбор")) return;
			feedbackStartedResolve();
			await feedbackGate;
		};

		await bot.receive({
			messageId: 313,
			chatId: "42",
			text: "99",
			replyToMessageId: questionMessage.messageId,
		});
		await feedbackStarted;
		await bot.receive({
			messageId: 314,
			chatId: "42",
			text: "2",
			replyToMessageId: questionMessage.messageId,
		});
		releaseFeedback();

		assert.deepEqual(await pending, [{ id: "choice", choiceValue: "b" }]);
		coordinator.stop();
	});

	it("cleans the re-armed question route when validation feedback fails", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		const pending = coordinator.askQuestions("session-a", [normalizedQuestion()]);
		await nextMacrotask();
		const questionMessage = bot.sent.at(-1)!;
		bot.beforeSend = async (text) => {
			if (text.startsWith("Не понял выбор")) throw new Error("telegram unavailable");
		};

		await bot.receive({
			messageId: 315,
			chatId: "42",
			text: "99",
			replyToMessageId: questionMessage.messageId,
		});
		await assert.rejects(pending, /telegram unavailable/u);

		bot.beforeSend = undefined;
		await bot.receive({ messageId: 316, chatId: "42", text: "normal follow-up" });
		assert.deepEqual(session.userMessages, ["normal follow-up"]);
		coordinator.stop();
	});

	it("cancels a pending Telegram question when the tool AbortSignal fires", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		const abortController = new AbortController();
		const pending = coordinator.askQuestions("session-a", [normalizedQuestion()], abortController.signal);
		await nextMacrotask();
		abortController.abort();

		assert.equal(await pending, null);
		coordinator.stop();
	});

	it("keeps bot commands out of the implicit single-question answer path", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		const pending = coordinator.askQuestions("session-a", [normalizedQuestion()]);
		await nextMacrotask();
		const questionMessage = bot.sent.at(-1)!;

		await bot.receive({ messageId: 303, chatId: "42", text: "/status" });
		assert.match(bot.sent.at(-1)!.text, /idle.*session-a/u);

		await bot.receive({ messageId: 304, chatId: "42", text: "/new another task" });
		assert.match(bot.sent.at(-1)!.text, /ждёт ответа на вопрос/u);
		assert.deepEqual(session.newSessionRequestIds, []);

		await bot.receive({
			messageId: 305,
			chatId: "42",
			text: "1",
			replyToMessageId: questionMessage.messageId,
		});
		assert.deepEqual(await pending, [{ id: "choice", choiceValue: "a" }]);
		coordinator.stop();
	});

	it("requires an explicit reply when multiple sessions are waiting on questions", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const first = fakeEndpoint("session-a", "/repo/a");
		const second = fakeEndpoint("session-b", "/repo/b");
		coordinator.attachSession(first.endpoint, enabledConfig());
		coordinator.attachSession(second.endpoint, enabledConfig());
		const firstPending = coordinator.askQuestions("session-a", [normalizedQuestion()]);
		await nextMacrotask();
		const firstQuestion = bot.sent.at(-1)!;
		const secondPending = coordinator.askQuestions("session-b", [{ ...normalizedQuestion(), id: "second" }]);
		await nextMacrotask();
		const secondQuestion = bot.sent.at(-1)!;

		await bot.receive({ messageId: 306, chatId: "42", text: "1" });
		assert.match(bot.sent.at(-1)!.text, /несколько ожидающих вопросов/u);
		assert.deepEqual(first.userMessages, []);
		assert.deepEqual(second.userMessages, []);

		await bot.receive({
			messageId: 307,
			chatId: "42",
			text: "1",
			replyToMessageId: firstQuestion.messageId,
		});
		await bot.receive({
			messageId: 308,
			chatId: "42",
			text: "2",
			replyToMessageId: secondQuestion.messageId,
		});
		assert.deepEqual(await firstPending, [{ id: "choice", choiceValue: "a" }]);
		assert.deepEqual(await secondPending, [{ id: "second", choiceValue: "b" }]);
		coordinator.stop();
	});

	it("requires an explicit reply for ordinary messages when multiple sessions are live", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const first = fakeEndpoint("session-a", "/repo/a");
		const second = fakeEndpoint("session-b", "/repo/b");
		coordinator.attachSession(first.endpoint, enabledConfig());
		coordinator.attachSession(second.endpoint, enabledConfig());

		await coordinator.notifyCompletion("session-a", "complete");
		await coordinator.notifyCompletion("session-b", "complete");
		await bot.receive({ messageId: 310, chatId: "42", text: "do the next thing" });

		assert.deepEqual(first.userMessages, []);
		assert.deepEqual(second.userMessages, []);
		assert.match(bot.sent.at(-1)!.text, /несколько живых сессий/u);
		coordinator.stop();
	});

	it("allows only one pending new-session replacement per source session", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const session = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(session.endpoint, enabledConfig());
		await coordinator.notifyCompletion("session-a", "complete");
		const notification = bot.sent.at(-1)!;

		await bot.receive({
			messageId: 311,
			chatId: "42",
			text: "/new first task",
			replyToMessageId: notification.messageId,
		});
		await bot.receive({
			messageId: 312,
			chatId: "42",
			text: "/new second task",
			replyToMessageId: notification.messageId,
		});

		assert.equal(session.newSessionRequestIds.length, 1);
		assert.match(bot.sent.at(-1)!.text, /Не удалось запустить новую сессию/u);
		coordinator.finishNewSessionRequest("session-a");
		coordinator.stop();
	});

	it("ignores a stale detach after a newer endpoint claimed the same session id", async () => {
		const bot = new FakeBot();
		const coordinator = new TelegramConnectorCoordinator(() => bot);
		const oldEndpoint = fakeEndpoint("session-a", "/repo/a");
		const freshEndpoint = fakeEndpoint("session-a", "/repo/a");
		coordinator.attachSession(oldEndpoint.endpoint, enabledConfig());
		coordinator.attachSession(freshEndpoint.endpoint, enabledConfig());
		coordinator.detachSession("session-a", oldEndpoint.endpoint);

		await coordinator.notifyCompletion("session-a", "complete");
		const notification = bot.sent.at(-1)!;
		await bot.receive({
			messageId: 309,
			chatId: "42",
			text: "fresh only",
			replyToMessageId: notification.messageId,
		});

		assert.deepEqual(oldEndpoint.userMessages, []);
		assert.deepEqual(freshEndpoint.userMessages, ["fresh only"]);
		coordinator.stop();
	});
});

describe("telegram connector extension integration", () => {
	it("does not make agent_settled wait for Telegram delivery", async () => {
		resetTelegramConnectorCoordinatorForTests();
		const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
		const fakePi = {
			registerCommand() {},
			on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
				handlers.set(name, handler);
			},
			events: { on() { return () => {}; } },
			sendUserMessage() {},
			getSessionName() { return "Source"; },
		};

		await withProcessEnv({ PIX_TELEGRAM_CONNECTOR: "0" }, async () => {
			telegramConnector(fakePi as never);
			const coordinator = getTelegramConnectorCoordinator();
			coordinator.notifyCompletion = async () => await new Promise<void>(() => {});
			const ctx = fakeExtensionContext("source-session");
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);

			const result = handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
			assert.equal(result, undefined);
		});
		resetTelegramConnectorCoordinatorForTests();
	});

	it("uses a fresh command context to create a new session and submit its first task", async () => {
		resetTelegramConnectorCoordinatorForTests();
		const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
		const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
		const dispatched: Array<{ text: string; options?: unknown }> = [];
		const fakePi = {
			registerCommand(name: string, command: { handler(args: string, ctx: any): Promise<void> }) {
				commands.set(name, command);
			},
			on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
				handlers.set(name, handler);
			},
			events: { on() { return () => {}; } },
			sendUserMessage(text: string, options?: unknown) {
				dispatched.push({ text, options });
			},
			getSessionName() { return "Source"; },
		};
		const sourceCtx = fakeExtensionContext("source-session");

		await withProcessEnv({ PIX_TELEGRAM_CONNECTOR: "0" }, async () => {
			telegramConnector(fakePi as never);
			await handlers.get("session_start")?.({ type: "session_start" }, sourceCtx);
			const coordinator = getTelegramConnectorCoordinator();
			const requestId = coordinator.createNewSessionRequest("source-session", "fresh task");
			assert.ok(requestId);
			assert.match(dispatched[0]!.text, /^\/telegram-new-session [0-9a-f-]+$/u);

			const sentIntoNewSession: Array<{ text: string; options?: unknown }> = [];
			let releaseNewTurn!: () => void;
			const newTurnGate = new Promise<void>((resolve) => {
				releaseNewTurn = resolve;
			});
			const commandPromise = commands.get("telegram-new-session")!.handler(requestId!, {
				sessionManager: { getSessionId: () => "source-session" },
				waitForIdle: async () => {},
				newSession: async (options: { withSession(nextCtx: any): Promise<void> }) => {
					await options.withSession({
						sessionManager: { getSessionId: () => "new-session" },
						sendUserMessage: async (text: string, sendOptions?: unknown) => {
							sentIntoNewSession.push({ text, options: sendOptions });
							await newTurnGate;
						},
					});
					return { cancelled: false };
				},
			});
			const handlerReturned = await Promise.race([
				commandPromise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
			]);

			assert.equal(handlerReturned, true, "new-session command must not wait for the new agent turn to finish");
			assert.deepEqual(sentIntoNewSession, [{ text: "fresh task", options: { expandPromptTemplates: false } }]);
			releaseNewTurn();
			await commandPromise;
		});
		resetTelegramConnectorCoordinatorForTests();
	});

	it("lets the question tool complete from Telegram even when local UI is unavailable", async () => {
		let tool: any;
		questionExtension({ registerTool(registered) { tool = registered; } });
		const unregister = registerRemoteQuestionHandler("remote-session", async () => [
			{ id: "choice", choiceValue: "b" },
		]);
		try {
			const result = await tool.execute("call-1", { questions: [{
				id: "choice",
				label: "Pick",
				prompt: "Choose one",
				choices: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
			}] } satisfies QuestionToolInput, undefined, undefined, {
				hasUI: false,
				sessionManager: { getSessionId: () => "remote-session" },
				ui: {},
			});
			assert.equal(result.details.canceled, false);
			assert.deepEqual(result.details.answers, [{
				id: "choice",
				value: "b",
				label: "B",
				wasCustom: false,
				index: 2,
			}]);
		} finally {
			unregister();
		}
	});

	it("extracts only assistant-visible text for completion summaries", () => {
		assert.equal(assistantVisibleText({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret reasoning" },
				{ type: "text", text: "Visible result" },
			],
		}), "Visible result");
		assert.equal(assistantVisibleText({ role: "user", content: "not assistant" }), undefined);
	});
});

class FakeBot {
	readonly sent: Array<{ messageId: number; text: string }> = [];
	beforeSend: ((text: string) => Promise<void>) | undefined;
	private incoming: ((message: TelegramIncomingMessage) => void | Promise<void>) | undefined;
	private nextMessageId = 100;

	start(onMessage: (message: TelegramIncomingMessage) => void | Promise<void>): void {
		this.incoming = onMessage;
	}

	stop(): void {
		this.incoming = undefined;
	}

	async sendMessage(text: string): Promise<number> {
		await this.beforeSend?.(text);
		const messageId = this.nextMessageId++;
		this.sent.push({ messageId, text });
		return messageId;
	}

	async receive(message: TelegramIncomingMessage): Promise<void> {
		assert.ok(this.incoming, "fake bot must be started");
		await this.incoming(message);
	}
}

function fakeEndpoint(sessionId: string, cwd: string): {
	endpoint: TelegramSessionEndpoint;
	userMessages: string[];
	newSessionRequestIds: string[];
} {
	const userMessages: string[] = [];
	const newSessionRequestIds: string[] = [];
	return {
		endpoint: {
			sessionId,
			cwd,
			getTitle: () => sessionId,
			isIdle: () => true,
			sendUserMessage: (text) => userMessages.push(text),
			dispatchNewSession: (requestId) => newSessionRequestIds.push(requestId),
		},
		userMessages,
		newSessionRequestIds,
	};
}

function fakeExtensionContext(sessionId: string): any {
	return {
		cwd: "/repo/source",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Source",
		},
		ui: { notify() {} },
	};
}

function normalizedQuestion(): NormalizedQuestion {
	return {
		id: "choice",
		label: "Pick",
		prompt: "Choose one",
		choices: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		],
	};
}

function enabledConfig() {
	return { enabled: true, botToken: "test-token", chatId: "42" } as const;
}

function withTempConfig<T>(content: string, fn: (configPath: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pix-telegram-connector-"));
	try {
		const configPath = join(dir, "pi-tools-suite.jsonc");
		writeFileSync(configPath, content, "utf8");
		return fn(configPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function withProcessEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	try {
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		return await fn();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function nextMacrotask(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
