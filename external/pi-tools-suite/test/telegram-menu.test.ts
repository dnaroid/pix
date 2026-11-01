import { describe, expect, test } from "bun:test";

import { TelegramBridgeBroker, type BrokerState } from "../src/telegram-bridge/broker.js";
import { menuCommand, menuKeyboard } from "../src/telegram-bridge/menu.js";
import type { BrokerMessage } from "../src/telegram-bridge/protocol.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "../src/telegram-bridge/telegram-api.js";

const CHAT = -1001234567890;
const USER = 42;

function message(threadId?: number): TelegramMessage {
	return {
		message_id: 10, chat: { id: CHAT, type: "supergroup", is_forum: true }, from: { id: USER },
		...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
	};
}

function callback(command: string, threadId?: number, overrides: Partial<TelegramCallbackQuery> = {}): TelegramUpdate {
	return {
		update_id: 1,
		callback_query: {
			id: "click", data: `pix:menu:${command}`, from: { id: USER },
			message: { ...message(threadId), from: { id: 123, is_bot: true } }, ...overrides,
		},
	};
}

async function fixture() {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const received: BrokerMessage[] = [];
	const reports: string[] = [];
	const state: BrokerState = { offset: 0, topics: {} };
	let failAck = false;
	const broker = new TelegramBridgeBroker({
		chatId: CHAT, allowedUserIds: [USER], state, saveState() {},
		report: (_level, event) => { reports.push(event); },
		send: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
			calls.push({ method, params });
			if (method === "answerCallbackQuery" && failAck) throw new Error("ack failed");
			return (method === "createForumTopic" ? { message_thread_id: calls.length, name: params.name } : true) as T;
		},
	});
	const connection = { send: (value: BrokerMessage) => { received.push(value); } };
	broker.handleClientMessage(connection, { t: "register", sessionId: "a", project: "pix", cwd: "/work/pix", title: "First" });
	broker.handleClientMessage(connection, { t: "register", sessionId: "b", project: "api", cwd: "/work/api", title: "Second" });
	await broker.idle();
	calls.length = 0;
	return { broker, calls, received, reports, state, connection, failAck: () => { failAck = true; } };
}

describe("Telegram inline menu", () => {
	test("parses only exact allowlisted callbacks", () => {
		for (const name of ["sessions", "status", "stop", "help"]) expect(menuCommand(`pix:menu:${name}`)).toBe(name);
		for (const data of [undefined, "stop", "pix:menu:prompt", "pix:menu:stop extra", "pix:menu:stop:session"]) {
			expect(menuCommand(data)).toBeUndefined();
		}
	});

	test("/menu with a bot suffix shows general or topic-specific buttons without prompting", async () => {
		const { broker, calls, received, state } = await fixture();
		try {
			for (const threadId of [undefined, state.topics.a!.threadId, 999]) {
				broker.handleUpdate({ update_id: 1, message: { ...message(threadId), text: "/menu@pix_mirror_bot" } });
				const reply = calls.at(-1)!;
				expect(reply.method).toBe("sendMessage");
				expect(reply.params.reply_markup).toEqual(menuKeyboard(threadId === state.topics.a!.threadId));
				expect(reply.params.message_thread_id).toBe(threadId);
			}
			expect(received).toEqual([]);
		} finally { broker.dispose(); }
	});

	test("buttons list sessions, show help/status and stop only the owning session", async () => {
		const { broker, calls, received, state } = await fixture();
		try {
			broker.handleUpdate(callback("sessions"));
			expect(String(calls.at(-1)!.params.text)).toContain("First – https://t.me/c/");
			broker.handleUpdate(callback("help"));
			expect(String(calls.at(-1)!.params.text)).toContain("/menu");
			broker.handleUpdate(callback("status", state.topics.b!.threadId));
			expect(calls.at(-1)!.params.text).toBe("🟢 Running in /work/api");
			broker.handleUpdate(callback("stop", state.topics.b!.threadId));
			expect(received).toEqual([expect.objectContaining({ t: "stop", sessionId: "b" })]);
			expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(4);
		} finally { broker.dispose(); }
	});

	test("re-registration restores project prefixes without recreating topics", async () => {
		const { broker, calls, state, connection } = await fixture();
		try {
			state.topics.a!.name = "First";
			const threadId = state.topics.a!.threadId;
			broker.handleClientMessage(connection, { t: "register", sessionId: "a", project: "pix", cwd: "/work/pix", title: "First" });
			await broker.idle();
			expect(calls).toEqual([{ method: "editForumTopic", params: { chat_id: CHAT, message_thread_id: threadId, name: "pix · First" } }]);
			expect(state.topics.a!.name).toBe("pix · First");
		} finally { broker.dispose(); }
	});

	test("/menu and callbacks stay inactive in setup mode and reject unauthorized menus", async () => {
		const { broker, calls, received, state } = await fixture();
		try {
			broker.handleUpdate({ update_id: 1, message: { ...message(), from: { id: 999 }, text: "/menu" } });
			expect(calls).toEqual([]);
			broker.reconfigure({ allowedUserIds: [USER] });
			broker.handleUpdate({ update_id: 1, message: { ...message(), text: "/menu" } });
			broker.handleUpdate(callback("stop", state.topics.a!.threadId));
			expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
			expect(received).toEqual([]);
		} finally { broker.dispose(); }
	});

	test("callback actor must pass chat/user authorization, even on a legitimate bot menu", async () => {
		const { broker, calls, received, state, reports } = await fixture();
		try {
			const threadId = state.topics.a!.threadId;
			broker.handleUpdate(callback("stop", threadId, { from: { id: 999 } }));
			broker.handleUpdate(callback("stop", threadId, { from: { id: USER, is_bot: true } }));
			broker.handleUpdate(callback("stop", threadId, { message: { ...message(threadId), chat: { id: -100999, type: "supergroup" } } }));
			expect(received).toEqual([]);
			expect(calls.every((call) => call.method === "answerCallbackQuery")).toBe(true);
			expect(reports).toContain("unauthorized-message");
		} finally { broker.dispose(); }
	});

	test("stale topics, unsupported data and inaccessible messages cannot become prompts", async () => {
		const { broker, calls, received, state, connection } = await fixture();
		try {
			broker.handleClientMessage(connection, { t: "unregister", sessionId: "a" });
			broker.handleUpdate(callback("stop", state.topics.a!.threadId));
			expect(String(calls.at(-1)!.params.text)).toContain("not running");
			broker.handleUpdate(callback("stop"));
			expect(String(calls.at(-1)!.params.text)).toContain("not linked");
			const count = calls.length;
			broker.handleUpdate(callback("arbitrary prompt", 1));
			broker.handleUpdate(callback("stop", 1, { message: undefined }));
			broker.handleUpdate(callback("stop", 1, { message: { ...message(1), message_id: 0 } }));
			expect(calls.slice(count).map((call) => call.method)).toEqual(Array(3).fill("answerCallbackQuery"));
			expect(received).toEqual([]);
		} finally { broker.dispose(); }
	});

	test("acknowledgment failures are logged and disposed brokers ignore clicks", async () => {
		const { broker, calls, received, reports, state, failAck } = await fixture();
		failAck();
		broker.handleUpdate(callback("stop", state.topics.a!.threadId));
		await Promise.resolve();
		expect(reports).toContain("telegram-call-failed");
		expect(received).toHaveLength(1);
		broker.dispose();
		const count = calls.length;
		broker.handleUpdate(callback("stop", 1));
		expect(calls).toHaveLength(count);
	});
});
