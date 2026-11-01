import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TelegramBridgeBroker, type BrokerConnection, type BrokerState } from "../src/telegram-bridge/broker.js";
import { acquireLock, TelegramBridgeBrokerHost } from "../src/telegram-bridge/broker-host.js";
import { TelegramBridgeClient } from "../src/telegram-bridge/client.js";
import { loadTelegramBridgeConfig, TELEGRAM_BRIDGE_CONFIG_TEMPLATE, writeTelegramBridgeConfigTemplate, type TelegramBridgeConfig } from "../src/telegram-bridge/config.js";
import { parseCommand, projectIconColor, splitMessage, topicLink, topicName } from "../src/telegram-bridge/format.js";
import { assistantText, createTelegramBridgeExtension, isBridgeEligible, TELEGRAM_INBOUND_CHANNEL } from "../src/telegram-bridge/index.js";
import { LineDecoder, parseClientMessage, type BrokerMessage, type ClientMessage } from "../src/telegram-bridge/protocol.js";
import { TelegramApiError, TelegramSendQueue, TOPIC_ICON_COLORS, type TelegramUpdate } from "../src/telegram-bridge/telegram-api.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc";
const CHAT = -1001234567890;
const USER = 4242;

const tempDirs: string[] = [];
function tempDir(): string {
	// Short prefix: unix socket paths are length-limited on macOS.
	const dir = mkdtempSync(join(tmpdir(), "tgb-"));
	tempDirs.push(dir);
	return dir;
}
const hosts: TelegramBridgeBrokerHost[] = [];
const clients: TelegramBridgeClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) client.dispose();
	for (const host of hosts.splice(0)) await host.dispose();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(condition: () => boolean, label = "condition"): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

type Call = { method: string; params: Record<string, unknown> };

function fakeTelegram() {
	const calls: Call[] = [];
	let nextThread = 100;
	const failures: Array<{ method: string; error: Error }> = [];
	const send = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
		calls.push({ method, params });
		const index = failures.findIndex((failure) => failure.method === method);
		if (index >= 0) throw failures.splice(index, 1)[0]!.error;
		if (method === "createForumTopic") return { message_thread_id: nextThread++, name: params.name } as T;
		return true as T;
	};
	return { calls, send, failNext: (method: string, error: Error) => failures.push({ method, error }) };
}

function fakeTimers() {
	const timers = new Map<number, () => void>();
	let id = 0;
	return {
		setTimer: (callback: () => void) => { timers.set(++id, callback); return id; },
		clearTimer: (handle: unknown) => { timers.delete(handle as number); },
		fireAll: () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
		get size() { return timers.size; },
	};
}

function connection(): BrokerConnection & { messages: BrokerMessage[] } {
	const messages: BrokerMessage[] = [];
	return { messages, send: (message) => { messages.push(message); } };
}

function makeBroker(overrides: { chatId?: number | undefined } = {}) {
	const telegram = fakeTelegram();
	const timers = fakeTimers();
	const state: BrokerState = { offset: 0, topics: {} };
	let saves = 0;
	const broker = new TelegramBridgeBroker({
		...("chatId" in overrides ? (overrides.chatId === undefined ? {} : { chatId: overrides.chatId }) : { chatId: CHAT }),
		allowedUserIds: [USER],
		send: telegram.send,
		state,
		saveState: () => { saves++; },
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		now: () => 1000,
	});
	return { broker, telegram, timers, state, saves: () => saves };
}

function register(sessionId: string, cwd: string, title?: string): ClientMessage {
	return { t: "register", sessionId, project: cwd.split("/").pop()!, cwd, ...(title ? { title } : {}) };
}

let updateId = 1;
function topicMessage(threadId: number | undefined, text: string, from = USER, chatId = CHAT): TelegramUpdate {
	return {
		update_id: updateId++,
		message: {
			message_id: updateId,
			chat: { id: chatId, type: "supergroup", is_forum: true },
			from: { id: from },
			text,
			...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
		},
	};
}

describe("telegram-bridge config", () => {
	const read = (content: string | undefined) => (path: string) => {
		if (content === undefined) throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
		return content;
	};

	test("is missing without a token and reports the file path", () => {
		const result = loadTelegramBridgeConfig({ env: {}, homeDir: "/home/me", readFile: read(undefined) });
		expect(result).toMatchObject({ ok: false, reason: "missing", path: "/home/me/.config/pi/telegram-bridge.jsonc" });
	});

	test("reads JSONC credentials and lets the environment override them", () => {
		const file = `{ // comment\n "botToken": "${TOKEN}", "chatId": ${CHAT}, "allowedUserIds": [${USER}] }`;
		const result = loadTelegramBridgeConfig({ env: {}, homeDir: "/home/me", readFile: read(file) });
		expect(result).toEqual({ ok: true, config: { botToken: TOKEN, chatId: CHAT, allowedUserIds: [USER], stateDir: "/home/me/.pi/agent/telegram-bridge" } });
		const overridden = loadTelegramBridgeConfig({
			env: { PIX_TELEGRAM_CHAT_ID: "-1009", PIX_TELEGRAM_ALLOWED_USER_IDS: "1, 2", PIX_TELEGRAM_BRIDGE_DIR: "/state" },
			homeDir: "/home/me", readFile: read(file),
		});
		expect(overridden.ok && overridden.config).toMatchObject({ chatId: -1009, allowedUserIds: [1, 2], stateDir: "/state" });
	});

	test("flags a missing file and writes a template that never overwrites", () => {
		expect(loadTelegramBridgeConfig({ env: {}, homeDir: "/h", readFile: read(undefined) })).toMatchObject({ fileMissing: true, detail: "config file does not exist" });
		const file = join(tempDir(), "nested", "telegram-bridge.jsonc");
		expect(writeTelegramBridgeConfigTemplate(file)).toBe(true);
		expect(writeTelegramBridgeConfigTemplate(file)).toBe(false);
		const parsed = loadTelegramBridgeConfig({ env: { PIX_TELEGRAM_BRIDGE_CONFIG: file }, homeDir: "/h" });
		expect(parsed).toMatchObject({ ok: false, reason: "missing", detail: "botToken is not configured" });
		expect("fileMissing" in parsed).toBe(false);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("rejects malformed values and honors enabled:false", () => {
		const base = { env: {}, homeDir: "/h" };
		expect(loadTelegramBridgeConfig({ ...base, readFile: read(`{"botToken":"nope"}`) })).toMatchObject({ ok: false, reason: "invalid" });
		expect(loadTelegramBridgeConfig({ ...base, readFile: read(`{"botToken":"${TOKEN}","chatId":5}`) })).toMatchObject({ ok: false, reason: "invalid" });
		expect(loadTelegramBridgeConfig({ ...base, readFile: read(`{"botToken":"${TOKEN}","allowedUserIds":["x"]}`) })).toMatchObject({ ok: false, reason: "invalid" });
		expect(loadTelegramBridgeConfig({ ...base, readFile: read(`{"enabled":false,"botToken":"${TOKEN}"}`) })).toMatchObject({ ok: false, reason: "missing" });
		// Setup mode: token only, no chat yet.
		expect(loadTelegramBridgeConfig({ ...base, readFile: read(`{"botToken":"${TOKEN}"}`) })).toMatchObject({ ok: true, config: { allowedUserIds: [] } });
	});
});

describe("telegram-bridge protocol and formatting", () => {
	test("decodes split, multiple and oversized NDJSON lines", () => {
		const seen: unknown[] = [];
		const decoder = new LineDecoder((value) => seen.push(value), 32);
		decoder.push('{"a":');
		decoder.push('1}\n{"b":2}\nnot json\n');
		decoder.push(`{"big":"${"x".repeat(64)}`);
		decoder.push('"}\n{"c":3}\n');
		expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	test("validates client messages", () => {
		expect(parseClientMessage({ t: "register", sessionId: "s-1", project: "p", cwd: "/p" })).toEqual({ t: "register", sessionId: "s-1", project: "p", cwd: "/p" });
		expect(parseClientMessage({ t: "register", sessionId: "../x", project: "p", cwd: "/p" })).toBeUndefined();
		expect(parseClientMessage({ t: "notify", sessionId: "s", kind: "boom", text: "x" })).toBeUndefined();
		expect(parseClientMessage({ t: "ack", sessionId: "s", requestId: "r", ok: "yes" })).toBeUndefined();
	});

	test("splits long text on line boundaries within the Telegram limit", () => {
		const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"word ".repeat(10)}`).join("\n");
		const chunks = splitMessage(text, 1000);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
		expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
		expect(splitMessage("")).toEqual([""]);
		const emoji = "😀".repeat(600);
		expect(splitMessage(emoji, 999).every((chunk) => !/[\ud800-\udbff]$/.test(chunk))).toBe(true);
	});

	test("names topics per project and session and colors them per project", () => {
		expect(topicName("pix", "Fix scrolling")).toBe("pix · Fix scrolling");
		expect(topicName("pix", undefined)).toBe("pix · new session");
		expect(topicName("pix", " \n ")).toBe("pix · new session");
		expect(topicName("pix", " Fix\n scrolling ")).toBe("pix · Fix scrolling");
		expect(topicName("p", "x".repeat(300)).length).toBe(128);
		expect(projectIconColor("/work/pix")).toBe(projectIconColor("/work/pix"));
		expect(TOPIC_ICON_COLORS).toContain(projectIconColor("/work/api") as never);
		expect(topicLink(CHAT, 7)).toBe("https://t.me/c/1234567890/7");
		expect(parseCommand("/stop@PixBot")).toEqual({ command: "stop", args: "" });
		expect(parseCommand("hello /stop")).toBeUndefined();
	});

	test("send queue serializes calls and honors 429 retry_after", async () => {
		const log: string[] = [];
		const sleeps: number[] = [];
		let first = true;
		const queue = new TelegramSendQueue(async <T>(method: string) => {
			log.push(`start ${method}`);
			if (method === "a" && first) { first = false; throw new TelegramApiError("a", 429, "Too Many Requests", 3); }
			await new Promise((resolve) => setTimeout(resolve, 1));
			log.push(`end ${method}`);
			return method as T;
		}, async (ms) => { sleeps.push(ms); });
		const results = await Promise.all([queue.run("a", {}), queue.run("b", {})]);
		expect(results).toEqual(["a", "b"]);
		expect(sleeps).toEqual([3000]);
		expect(log).toEqual(["start a", "start a", "end a", "start b", "end b"]);
	});
});

describe("telegram-bridge broker", () => {
	test("creates one topic per session, colored by project, across projects", async () => {
		const { broker, telegram, state } = makeBroker();
		const a = connection();
		const b = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix", "Refactor auth"));
		broker.handleClientMessage(a, register("s2", "/work/pix"));
		broker.handleClientMessage(b, register("s3", "/work/api", "Fix tests"));
		await broker.idle();
		const created = telegram.calls.filter((call) => call.method === "createForumTopic");
		expect(created.map((call) => call.params.name)).toEqual(["pix · Refactor auth", "pix · new session", "api · Fix tests"]);
		expect(created[0]!.params.icon_color).toBe(created[1]!.params.icon_color);
		expect(created[2]!.params.icon_color).toBe(projectIconColor("/work/api"));
		expect(Object.keys(state.topics).sort()).toEqual(["s1", "s2", "s3"]);
		expect(broker.liveSessionIds.sort()).toEqual(["s1", "s2", "s3"]);
	});

	test("orders a notify behind the topic creation it depends on", async () => {
		const { broker, telegram } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		broker.handleClientMessage(a, { t: "notify", sessionId: "s1", kind: "final", text: "Done" });
		await broker.idle();
		expect(telegram.calls.map((call) => call.method)).toEqual(["createForumTopic", "sendMessage"]);
		expect(telegram.calls[1]!.params).toMatchObject({ chat_id: CHAT, message_thread_id: 100, text: "✅ Done" });
	});

	test("renames, closes after a grace period, and reopens the same topic", async () => {
		const { broker, telegram, timers, state } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		broker.handleClientMessage(a, { t: "rename", sessionId: "s1", title: "Better name" });
		await broker.idle();
		expect(telegram.calls.at(-1)).toMatchObject({ method: "editForumTopic", params: { message_thread_id: 100, name: "pix · Better name" } });

		// Reload: unregister then register again inside the grace period → no churn.
		broker.handleClientMessage(a, { t: "unregister", sessionId: "s1" });
		broker.handleClientMessage(a, register("s1", "/work/pix", "Better name"));
		expect(timers.size).toBe(0);
		timers.fireAll();
		await broker.idle();
		expect(telegram.calls.some((call) => call.method === "closeForumTopic")).toBe(false);

		broker.handleClientMessage(a, { t: "unregister", sessionId: "s1" });
		timers.fireAll();
		await broker.idle();
		expect(telegram.calls.slice(-2).map((call) => call.method)).toEqual(["sendMessage", "closeForumTopic"]);
		expect(state.topics.s1!.closed).toBe(true);

		const b = connection();
		broker.handleClientMessage(b, register("s1", "/work/pix", "Better name"));
		await broker.idle();
		expect(telegram.calls.at(-1)).toMatchObject({ method: "reopenForumTopic", params: { message_thread_id: 100 } });
		expect(telegram.calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
		expect(state.topics.s1!.closed).toBe(false);
	});

	test("a dropped connection only ends the sessions it owned", async () => {
		const { broker, timers } = makeBroker();
		const a = connection();
		const b = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		broker.handleClientMessage(b, register("s2", "/work/api"));
		broker.detach(a);
		expect(broker.liveSessionIds).toEqual(["s2"]);
		expect(timers.size).toBe(1);
		// A late message from the dead connection cannot touch a session it no longer owns.
		broker.handleClientMessage(a, { t: "notify", sessionId: "s2", kind: "final", text: "stale" });
		await broker.idle();
	});

	test("routes topic messages to the owning session and handles commands", async () => {
		const { broker, telegram } = makeBroker();
		const pix = connection();
		const api = connection();
		broker.handleClientMessage(pix, register("s1", "/work/pix", "Auth"));
		broker.handleClientMessage(api, register("s2", "/work/api", "Tests"));
		await broker.idle();

		broker.handleUpdate(topicMessage(101, "run the api tests"));
		expect(api.messages).toEqual([expect.objectContaining({ t: "prompt", sessionId: "s2", text: "run the api tests" })]);
		expect(pix.messages).toEqual([]);

		broker.handleUpdate(topicMessage(100, "/stop@PixBot"));
		expect(pix.messages).toEqual([expect.objectContaining({ t: "stop", sessionId: "s1" })]);

		broker.handleUpdate(topicMessage(undefined, "/sessions"));
		await broker.idle();
		const overview = String(telegram.calls.at(-1)!.params.text);
		expect(overview).toContain("📁 api (/work/api)");
		expect(overview).toContain("📁 pix (/work/pix)");
		expect(overview).toContain("• Auth – https://t.me/c/1234567890/100");
	});

	test("ignores strangers and other chats, but answers /id for setup", async () => {
		const { broker, telegram } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		const before = telegram.calls.length;
		broker.handleUpdate(topicMessage(100, "rm -rf /", 999));
		broker.handleUpdate(topicMessage(100, "hello", USER, -100777));
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(a.messages).toEqual([]);
		expect(telegram.calls.length).toBe(before);

		const setup = makeBroker({ chatId: undefined });
		setup.broker.handleUpdate(topicMessage(undefined, "/id", 999, -100555));
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(String(setup.telegram.calls[0]!.params.text)).toContain("chat id: -100555 (forum)\nyour user id: 999");
	});

	test("tells the user when a session is not running and acknowledges deliveries", async () => {
		const { broker, telegram, timers } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		broker.handleUpdate(topicMessage(100, "hi"));
		const prompt = a.messages[0] as Extract<BrokerMessage, { t: "prompt" }>;
		broker.handleClientMessage(a, { t: "ack", sessionId: "s1", requestId: prompt.requestId, ok: true });
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(telegram.calls.at(-1)).toMatchObject({ method: "setMessageReaction" });

		broker.handleUpdate(topicMessage(100, "again"));
		const second = a.messages[1] as Extract<BrokerMessage, { t: "prompt" }>;
		broker.handleClientMessage(a, { t: "ack", sessionId: "s1", requestId: second.requestId, ok: false, error: "busy" });
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(telegram.calls.at(-1)!.params.text).toBe("⚠️ busy");

		broker.handleClientMessage(a, { t: "unregister", sessionId: "s1" });
		timers.fireAll();
		await broker.idle();
		broker.handleUpdate(topicMessage(100, "are you there?"));
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(String(telegram.calls.at(-1)!.params.text)).toContain("not running");
		expect(a.messages).toHaveLength(2);
	});

	test("sends very long answers as a document and recreates a deleted topic", async () => {
		const { broker, telegram, state } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		broker.handleClientMessage(a, { t: "notify", sessionId: "s1", kind: "final", text: "x ".repeat(10_000) });
		await broker.idle();
		expect(telegram.calls.slice(-2).map((call) => call.method)).toEqual(["sendMessage", "sendDocument"]);
		expect(telegram.calls.at(-1)!.params.document).toBeInstanceOf(Blob);

		telegram.failNext("sendMessage", new TelegramApiError("sendMessage", 400, "Bad Request: message thread not found"));
		broker.handleClientMessage(a, { t: "notify", sessionId: "s1", kind: "final", text: "after delete" });
		await broker.idle();
		expect(telegram.calls.slice(-3).map((call) => call.method)).toEqual(["sendMessage", "createForumTopic", "sendMessage"]);
		expect(state.topics.s1!.threadId).toBe(101);
	});
});

describe("telegram-bridge broker reconfiguration", () => {
	test("setup mode creates topics for live sessions once chatId is configured", async () => {
		const { broker, telegram, state } = makeBroker({ chatId: undefined });
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		expect(telegram.calls).toEqual([]);
		broker.reconfigure({ chatId: CHAT, allowedUserIds: [USER] });
		await broker.idle();
		expect(telegram.calls.map((call) => call.method)).toEqual(["createForumTopic"]);
		expect(state.chatId).toBe(CHAT);
		broker.handleUpdate(topicMessage(100, "now routed"));
		expect(a.messages).toEqual([expect.objectContaining({ t: "prompt", text: "now routed" })]);
	});

	test("a different chat starts a fresh topic map; a legacy state keeps its topics", async () => {
		const { broker, telegram, state } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		broker.reconfigure({ chatId: -100999, allowedUserIds: [USER] });
		await broker.idle();
		expect(telegram.calls.filter((call) => call.method === "createForumTopic").map((call) => call.params.chat_id)).toEqual([CHAT, -100999]);
		expect(state).toMatchObject({ chatId: -100999, topics: { s1: { threadId: 101 } } });

		const legacy: BrokerState = { offset: 0, topics: { old: { threadId: 5, name: "x", closed: true, updatedAt: 0 } } };
		new TelegramBridgeBroker({ chatId: CHAT, allowedUserIds: [], send: telegram.send, state: legacy, saveState: () => {} });
		expect(legacy).toMatchObject({ chatId: CHAT, topics: { old: { threadId: 5 } } });
	});

	test("an updated allowlist applies to the next message", async () => {
		const { broker } = makeBroker();
		const a = connection();
		broker.handleClientMessage(a, register("s1", "/work/pix"));
		await broker.idle();
		broker.handleUpdate(topicMessage(100, "first", 777));
		expect(a.messages).toEqual([]);
		broker.reconfigure({ chatId: CHAT, allowedUserIds: [USER, 777] });
		broker.handleUpdate(topicMessage(100, "second", 777));
		expect(a.messages).toHaveLength(1);
	});
});

describe("telegram-bridge host and client", () => {
	function hostConfig(stateDir: string): TelegramBridgeConfig {
		return { botToken: TOKEN, chatId: CHAT, allowedUserIds: [USER], stateDir };
	}
	const silentCall = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
		(method === "createForumTopic" ? { message_thread_id: 7, name: params.name } : true) as T;

	test("polling subscribes to menu callbacks and dispatches them", async () => {
		const calls: Call[] = [];
		let delivered = false;
		const host = await TelegramBridgeBrokerHost.tryAcquire(hostConfig(tempDir()), {
			call: async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
				calls.push({ method, params });
				if (method !== "getUpdates") return true as T;
				if (!delivered) {
					delivered = true;
					return [{ update_id: 1, callback_query: {
						id: "menu-click", from: { id: USER }, data: "pix:menu:sessions",
						message: topicMessage(undefined, "Pix menu").message!,
					} }] as T;
				}
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return [] as T;
			},
		});
		expect(host).toBeDefined();
		hosts.push(host!);
		await until(() => calls.some((call) => call.method === "sendMessage"), "menu callback reply");
		expect(calls.find((call) => call.method === "getUpdates")!.params.allowed_updates).toEqual(["message", "callback_query"]);
		expect(calls.find((call) => call.method === "answerCallbackQuery")!.params).toEqual({ callback_query_id: "menu-click" });
		expect(calls.find((call) => call.method === "sendMessage")!.params.text).toBe("No Pix sessions are running.");
	});

	test("the lock admits one live owner and reclaims a dead one", () => {
		const dir = tempDir();
		const file = join(dir, "broker.lock");
		expect(acquireLock(file, 111, () => true)).toBe(true);
		expect(acquireLock(file, 222, () => true)).toBe(false);
		expect(acquireLock(file, 222, (pid) => pid !== 111)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("222");
	});

	test("reloads pending notification metadata from disk and edits it after takeover", async () => {
		const dir = tempDir();
		const config = hostConfig(dir);
		const telegram = fakeTelegram();
		const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
			if (method === "sendMessage") return { message_id: 83 } as T;
			return telegram.send<T>(method, params);
		};
		const first = await TelegramBridgeBrokerHost.tryAcquire(config, { call, poll: false, pid: 7001 });
		expect(first).toBeDefined();
		hosts.push(first!);
		const owner = connection();
		first!.broker.handleClientMessage(owner, register("s1", "/work/pix"));
		first!.broker.handleClientMessage(owner, { t: "notify", sessionId: "s1", kind: "final", text: "**Remember**" });
		await first!.broker.idle();
		await first!.dispose();
		expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).topics.s1.notifications[0])
			.toMatchObject({ messageId: 83, body: "<b>Remember</b>", parseMode: "HTML" });
		const second = await TelegramBridgeBrokerHost.tryAcquire(config, { call, poll: false, pid: 7002 });
		expect(second).toBeDefined();
		hosts.push(second!);
		second!.broker.handleClientMessage(owner, register("s1", "/work/pix"));
		second!.broker.handleClientMessage(owner, { t: "resolve", sessionId: "s1", scope: "answer" });
		await second!.broker.idle();
		expect(telegram.calls.find((entry) => entry.method === "editMessageText")!.params)
			.toMatchObject({ chat_id: CHAT, message_id: 83, text: "☑️ Ответ получен · обсуждение продолжено\n\n<b>Remember</b>" });
	});

	test.skipIf(process.platform === "win32")("a surviving session takes over when the broker process goes away", async () => {
		const dir = tempDir();
		const config = hostConfig(dir);
		const first = await TelegramBridgeBrokerHost.tryAcquire(config, { call: silentCall, poll: false, pid: 1001, closeGraceMs: 10_000 });
		expect(first).toBeDefined();
		hosts.push(first!);
		const received: BrokerMessage[] = [];
		let takeovers = 0;
		const client = new TelegramBridgeClient({
			socketPath: first!.socketPath,
			onMessage: (message) => received.push(message),
			tryBecomeBroker: async () => {
				takeovers++;
				const host = await TelegramBridgeBrokerHost.tryAcquire(config, { call: silentCall, poll: false, pid: 1002, isProcessAlive: () => false });
				if (host) hosts.push(host);
				return Boolean(host);
			},
		});
		clients.push(client);
		client.send({ t: "register", sessionId: "s1", project: "pix", cwd: "/work/pix", title: "Auth" });
		await until(() => first!.broker.liveSessionIds.includes("s1"), "registration on first broker");
		await first!.broker.idle();
		await first!.dispose();
		expect(existsSync(join(dir, "broker.lock"))).toBe(false);

		await until(() => TelegramBridgeBrokerHost.current() !== undefined
			&& TelegramBridgeBrokerHost.current()!.broker.liveSessionIds.includes("s1"), "re-registration after takeover");
		expect(takeovers).toBe(1);
		const second = TelegramBridgeBrokerHost.current()!;
		expect(readFileSync(join(dir, "broker.lock"), "utf8")).toBe("1002");
		// The persisted topic map survives the takeover: no duplicate topic.
		expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).topics.s1.threadId).toBe(7);

		second.broker.handleUpdate(topicMessage(7, "from phone"));
		await until(() => received.length === 1, "prompt over the socket");
		expect(received[0]).toMatchObject({ t: "prompt", sessionId: "s1", text: "from phone" });
	});

	test.skipIf(process.platform === "win32")("the broker picks up edited credentials and restarts on a new token", async () => {
		const dir = tempDir();
		let current: TelegramBridgeConfig | undefined = { ...hostConfig(dir), chatId: undefined as never };
		delete (current as { chatId?: number }).chatId;
		const host = await TelegramBridgeBrokerHost.tryAcquire(current, { call: silentCall, poll: false, pid: 3001, reloadConfig: () => current });
		hosts.push(host!);
		expect(host!.refreshConfig()).toBe("unchanged");
		current = hostConfig(dir);
		expect(host!.refreshConfig()).toBe("updated");
		current = undefined;
		expect(host!.refreshConfig()).toBe("unchanged");
		current = { ...hostConfig(dir), botToken: "999999:ZYXWVUTSRQPONMLKJIHGFEDCBA_zyx" };
		expect(host!.refreshConfig()).toBe("restarting");
		expect(TelegramBridgeBrokerHost.current()).toBeUndefined();
		await until(() => !existsSync(join(dir, "broker.lock")), "lock release");
	});

	test("a second process defers to a live broker", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "broker.lock"), "424242");
		const host = await TelegramBridgeBrokerHost.tryAcquire(hostConfig(dir), { call: silentCall, poll: false, pid: 1, isProcessAlive: () => true });
		expect(host).toBeUndefined();
	});
});

describe("telegram-bridge extension", () => {
	test("only user sessions are eligible", () => {
		expect(isBridgeEligible({ mode: "tui", hasUI: true }, {})).toBe(true);
		expect(isBridgeEligible({ mode: "rpc", hasUI: true }, { PIX_ACP_SESSION_STATE_BRIDGE: "1" })).toBe(true);
		expect(isBridgeEligible({ mode: "rpc", hasUI: true }, {})).toBe(false);
		expect(isBridgeEligible({ mode: "rpc", hasUI: true }, { PIX_ACP_SESSION_STATE_BRIDGE: "1", PI_SUBAGENT_META: "{}" })).toBe(false);
		expect(isBridgeEligible({ mode: "print", hasUI: false } as never, {})).toBe(false);
	});

	test("extracts final assistant text and provider errors", () => {
		expect(assistantText({ role: "user", content: "x" })).toBeUndefined();
		expect(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "A" }, { type: "text", text: "B" }] }))
			.toEqual({ text: "A\n\nB" });
		expect(assistantText({ role: "assistant", content: [], stopReason: "error", errorMessage: "429" })).toEqual({ text: "", error: "429" });
	});

	function harness(options: { idle?: boolean; configFile?: string } = {}) {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
		const notices: Array<{ text: string; level: string }> = [];
		const userMessages: Array<{ text: unknown; options: unknown }> = [];
		const widgets: unknown[] = [];
		let aborted = 0;
		let idle = options.idle ?? true;
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => { commands.set(name, command.handler); },
			getSessionName: () => "Auth",
			sendUserMessage: (text: unknown, opts?: unknown) => { userMessages.push({ text, options: opts }); },
		};
		const sent: ClientMessage[] = [];
		let onMessage: ((message: BrokerMessage) => void) | undefined;
		const ctx = {
			mode: "rpc", hasUI: true, cwd: "/work/pix",
			sessionManager: { getSessionId: () => "s1" },
			isIdle: () => idle,
			abort: () => { aborted++; },
			ui: {
				setWidget: (_key: string, lines: unknown) => widgets.push(lines),
				notify: (text: string, level: string) => notices.push({ text, level }),
			},
		};
		const env = { PIX_ACP_SESSION_STATE_BRIDGE: "1", ...(options.configFile ? { PIX_TELEGRAM_BRIDGE_CONFIG: options.configFile } : {}) };
		createTelegramBridgeExtension({
			env,
			loadConfig: options.configFile
				? () => loadTelegramBridgeConfig({ env: { ...env, PIX_TELEGRAM_BRIDGE_DIR: "/unused" } })
				: () => ({ ok: true, config: { botToken: TOKEN, chatId: CHAT, allowedUserIds: [USER], stateDir: "/unused" } }),
			createClient: (clientOptions) => {
				onMessage = clientOptions.onMessage;
				return { send: (message: ClientMessage) => { sent.push(message); }, dispose: () => {}, isConnected: true };
			},
		})(pi as never);
		const emit = (name: string, event: unknown = {}) => handlers.get(name)?.({ type: name, ...(event as object) }, ctx);
		return {
			emit, sent, userMessages, widgets, notices,
			command: (name: string) => commands.get(name)!("", ctx),
			deliver: (message: BrokerMessage) => onMessage!(message),
			setIdle: (value: boolean) => { idle = value; },
			get aborted() { return aborted; },
		};
	}

	test("registers, forwards the final answer and redacts secrets", () => {
		const h = harness();
		h.emit("session_start", { reason: "startup" });
		expect(h.sent[0]).toEqual({ t: "register", sessionId: "s1", project: "pix", cwd: "/work/pix", title: "Auth" });
		h.emit("agent_start");
		h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "interim" }] } });
		h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done" }] } });
		h.emit("agent_settled", { aborted: false });
		const notify = h.sent.at(-1) as Extract<ClientMessage, { t: "notify" }>;
		expect(notify.kind).toBe("final");
		expect(notify.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(notify.text).toContain("done");
		h.emit("agent_settled", { aborted: false });
		expect(h.sent.filter((message) => message.t === "notify")).toHaveLength(1);
	});

	test("delivers Telegram prompts as user messages, queued while busy", () => {
		const previous = process.env.PIX_ACP_SESSION_STATE_BRIDGE;
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		try {
			const h = harness();
			h.emit("session_start", { reason: "startup" });
			h.deliver({ t: "prompt", sessionId: "other", requestId: "r0", text: "wrong session" });
			expect(h.sent.at(-1)).toMatchObject({ t: "ack", requestId: "r0", ok: false });
			h.deliver({ t: "prompt", sessionId: "s1", requestId: "r1", text: "hello" });
			expect(h.userMessages.at(-1)).toEqual({ text: "hello", options: undefined });
			expect(h.widgets.at(-1)).toEqual([TELEGRAM_INBOUND_CHANNEL, JSON.stringify({ text: "hello" })]);
			expect(h.sent.at(-1)).toMatchObject({ t: "ack", requestId: "r1", ok: true });

			h.setIdle(false);
			h.deliver({ t: "prompt", sessionId: "s1", requestId: "r2", text: "next" });
			expect(h.userMessages.at(-1)).toEqual({ text: "next", options: { deliverAs: "followUp" } });
			h.deliver({ t: "stop", sessionId: "s1", requestId: "r3" });
			expect(h.aborted).toBe(1);

			h.emit("session_shutdown", { reason: "quit" });
			expect(h.sent.some((message) => message.t === "unregister")).toBe(true);
			h.deliver({ t: "prompt", sessionId: "s1", requestId: "r4", text: "late" });
			expect(h.userMessages.at(-1)!.text).toBe("next");
		} finally {
			if (previous === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE;
			else process.env.PIX_ACP_SESSION_STATE_BRIDGE = previous;
		}
	});

	test("Desktop input resolves answers immediately, but automatic extension input does not", () => {
		const h = harness();
		h.emit("session_start");
		h.emit("input", { source: "extension", text: "automatic follow-up" });
		h.emit("input", { source: "rpc", text: " " });
		expect(h.sent.filter((message) => message.t === "resolve")).toHaveLength(0);
		h.emit("input", { source: "rpc", text: "Продолжить" });
		h.emit("input", { source: "interactive", text: "", images: [{}] });
		expect(h.sent.filter((message) => message.t === "resolve")).toEqual([
			{ t: "resolve", sessionId: "s1", scope: "answer" },
			{ t: "resolve", sessionId: "s1", scope: "answer" },
		]);
		h.emit("session_shutdown", { reason: "switch" });
		h.emit("input", { source: "rpc", text: "late" });
		expect(h.sent.filter((message) => message.t === "resolve")).toHaveLength(2);
	});

	test("prompt closure resolves only the waiting notice, without claiming an answer", () => {
		const h = harness();
		h.emit("session_start");
		h.emit("ui_prompt_start", { kind: "select", title: "Выбор" });
		expect(h.sent.at(-1)).toMatchObject({ t: "notify", kind: "waiting", text: "Нужен ответ в Pix: Выбор" });
		h.emit("ui_prompt_end", { kind: "select", title: "Выбор" });
		expect(h.sent.at(-1)).toEqual({ t: "resolve", sessionId: "s1", scope: "waiting" });
	});

	test("/telegram creates the credentials template, then activates without a reload", async () => {
		const file = join(tempDir(), "pi", "telegram-bridge.jsonc");
		const h = harness({ configFile: file });
		h.emit("session_start", { reason: "startup" });
		expect(h.sent).toEqual([]);

		await h.command("telegram");
		expect(readFileSync(file, "utf8")).toBe(TELEGRAM_BRIDGE_CONFIG_TEMPLATE);
		expect(h.notices.at(-1)!.text).toContain(`Created ${file}.`);

		// Template exists but has no token yet: no overwrite, still inactive.
		await h.command("telegram");
		expect(readFileSync(file, "utf8")).toBe(TELEGRAM_BRIDGE_CONFIG_TEMPLATE);
		expect(h.notices.at(-1)!.text).toContain("botToken is not configured");
		expect(h.sent).toEqual([]);

		writeFileSync(file, TELEGRAM_BRIDGE_CONFIG_TEMPLATE.replace('"botToken": ""', `"botToken": "${TOKEN}"`));
		await h.command("telegram");
		expect(h.sent[0]).toMatchObject({ t: "register", sessionId: "s1" });
		expect(h.notices.at(-1)!.text).toContain("chatId is not set");
	});
});
