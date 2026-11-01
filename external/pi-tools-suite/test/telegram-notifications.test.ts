import { describe, expect, test } from "bun:test";

import { TelegramBridgeBroker, type BrokerConnection, type BrokerState } from "../src/telegram-bridge/broker.js";
import { cleanTelegramMarkdown, telegramChunks } from "../src/telegram-bridge/message-format.js";
import { loadNotifications } from "../src/telegram-bridge/notifications.js";
import { parseClientMessage, type BrokerMessage, type ClientMessage } from "../src/telegram-bridge/protocol.js";
import { TelegramApiError } from "../src/telegram-bridge/telegram-api.js";

const CHAT = -10077;
type Call = { method: string; params: Record<string, unknown> };
function harness(state: BrokerState = { offset: 0, topics: {} }) {
	const calls: Call[] = [];
	const warnings: string[] = [];
	const messages: BrokerMessage[] = [];
	let messageId = 10;
	let before: ((call: Call) => Promise<void>) | undefined;
	const owner: BrokerConnection = { send: (message) => { messages.push(message); } };
	const broker = new TelegramBridgeBroker({
		chatId: CHAT, allowedUserIds: [7], state, saveState: () => {},
		report: (_level, event) => { warnings.push(event); },
		send: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
			const call = { method, params };
			calls.push(call);
			await before?.(call);
			if (method === "createForumTopic") return { message_thread_id: 100, name: params.name } as T;
			if (method === "sendMessage") return { message_id: messageId++, chat: { id: CHAT } } as T;
			return true as T;
		},
	});
	broker.handleClientMessage(owner, { t: "register", sessionId: "s", project: "pix", cwd: "/pix" });
	const client = (message: Omit<Extract<ClientMessage, { t: "notify" }>, "sessionId"> | Omit<Extract<ClientMessage, { t: "resolve" }>, "sessionId">) => {
		broker.handleClientMessage(owner, { ...message, sessionId: "s" });
	};
	const prompt = (text = "continue", from = 7) => broker.handleUpdate({ update_id: 1, message: {
		message_id: 99, message_thread_id: 100, is_topic_message: true, chat: { id: CHAT, type: "supergroup" }, from: { id: from }, text,
	} });
	const ack = (ok: boolean, connection = owner, sessionId = "s") => {
		const request = messages.at(-1)!;
		broker.handleClientMessage(connection, { t: "ack", sessionId, requestId: request.requestId, ok });
	};
	return { broker, state, calls, messages, owner, warnings, client, prompt, ack,
		intercept: (callback?: (call: Call) => Promise<void>) => { before = callback; },
		edits: () => calls.filter((call) => call.method === "editMessageText"),
		sends: () => calls.filter((call) => call.method === "sendMessage"),
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("Telegram Markdown", () => {
	test("strips service fences but preserves ordinary code containing their names", () => {
		const input = "Before\n\n```pix-actions Apply\n- [x] secret action\n```\n\nAfter\n\n~~~pix-html\n<script>service</script>\n~~~";
		expect(cleanTelegramMarkdown(input)).toBe("Before\n\n\nAfter");
		expect(cleanTelegramMarkdown("````md\n```pix-actions\n- Done\n```\n````")).toContain("pix-actions");
		expect(cleanTelegramMarkdown("```pix-actions\n- Done")).toBe("");
	});

	test("renders common Markdown safely into the Telegram subset", () => {
		const [chunk] = telegramChunks("# Title\n\n**bold** *italic* ~~gone~~ `a < b` [link](https://example.com/?a=1&b=2)\n\n- item\n\n<script>x</script>\n\n```ts\nlet x = 1;\n```");
		expect(chunk!.html).toContain("<b>Title</b>");
		expect(chunk!.html).toContain("<b>bold</b> <i>italic</i> <s>gone</s> <code>a &lt; b</code>");
		expect(chunk!.html).toContain('<a href="https://example.com/?a=1&amp;b=2">link</a>');
		expect(chunk!.html).toContain("• item");
		expect(chunk!.html).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(chunk!.html).toContain("<pre>let x = 1;\n</pre>");
		expect(chunk!.plain).not.toContain("<b>");
		expect(telegramChunks("[bad](javascript:alert(1))")[0]!.html).not.toContain("<a ");
		expect(telegramChunks(`[long](https://example.com/?${"&".repeat(900)})`)[0]!.html.length).toBeLessThan(3400);
	});

	test("splits entity-heavy Unicode and long code with balanced tags and headroom", () => {
		const text = "<&😀 ".repeat(2000).trimEnd();
		const chunks = telegramChunks(`**${text}**`);
		expect(chunks.length).toBeGreaterThan(3);
		for (const chunk of chunks) {
			expect(chunk.html.length).toBeLessThanOrEqual(3400);
			expect(chunk.html.startsWith("<b>")).toBe(true);
			expect(chunk.html.endsWith("</b>")).toBe(true);
			expect(chunk.html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
		}
		expect(chunks.map((chunk) => chunk.plain).join("")).toBe(text);
		for (const chunk of telegramChunks(`\`\`\`\n${"x".repeat(12_000)}\n\`\`\``)) {
			expect(chunk.html).toMatch(/^<pre>[\s\S]*<\/pre>\n*$/);
		}
	});
});

describe("Telegram notification lifecycle", () => {
	test("validates resolution messages and bounded saved notices", () => {
		expect(parseClientMessage({ t: "resolve", sessionId: "s", scope: "answer" })).toEqual({ t: "resolve", sessionId: "s", scope: "answer" });
		expect(parseClientMessage({ t: "resolve", sessionId: "s", scope: "all" })).toBeUndefined();
		const valid = { messageId: 5, kind: "final", generation: 2, body: "body", parseMode: "HTML" };
		expect(loadNotifications([valid, null, { ...valid, body: "x".repeat(4000) }, { ...valid, messageId: 0 }])).toEqual([valid]);
		expect(loadNotifications(Array(100).fill(valid))).toHaveLength(12);
	});

	test("Desktop response edits every answer chunk, removes buttons and preserves history", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "final", text: `**${"hello ".repeat(900).trimEnd()}**\n\n\`\`\`pix-actions Apply\n- [x] action\n\`\`\`` });
		h.client({ t: "resolve", scope: "answer" }); // While send is still queued.
		await h.broker.idle();
		expect(h.sends()).toHaveLength(2);
		expect(h.edits()).toHaveLength(2);
		for (const edit of h.edits()) {
			expect(edit.params.text).toContain("☑️ Ответ получен · обсуждение продолжено");
			expect(edit.params.text).toContain("<b>");
			expect(edit.params.text).toContain("hello");
			expect(edit.params.text).not.toContain("pix-actions");
			expect(edit.params.reply_markup).toEqual({ inline_keyboard: [] });
			expect(String(edit.params.text).length).toBeLessThan(4096);
		}
		expect(h.state.topics.s!.notifications).toEqual([]);
		h.client({ t: "resolve", scope: "answer" });
		await h.broker.idle();
		expect(h.edits()).toHaveLength(2);
	});

	test("waiting and answers resolve independently; closed prompts never claim completion", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "final", text: "Answer" });
		h.client({ t: "notify", kind: "waiting", text: "Pick one" });
		h.client({ t: "resolve", scope: "waiting" });
		await h.broker.idle();
		expect(h.sends()[1]!.params.text).toContain("❓ Ожидает ответа");
		expect(h.edits()).toHaveLength(1);
		expect(h.edits()[0]!.params.text).toBe("☑️ Диалог закрыт\n\nPick one");
		expect(h.state.topics.s!.notifications).toHaveLength(1);
	});

	test("only an accepted authorized Telegram prompt resolves prior answers, never future answers", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "final", text: "old" });
		await h.broker.idle();
		h.prompt("intruder", 99);
		expect(h.messages).toHaveLength(0);
		h.prompt();
		h.client({ t: "notify", kind: "final", text: "new" });
		h.ack(true, { send: () => {} }); // Spoofed ack.
		h.ack(true, h.owner, "other");
		await h.broker.idle();
		expect(h.edits()).toHaveLength(0);
		h.ack(true);
		await h.broker.idle();
		expect(h.edits()).toHaveLength(1);
		expect(h.edits()[0]!.params.text).toContain("old");
		expect(h.state.topics.s!.notifications![0]!.body).toBe("new");
		h.prompt("/stop"); h.ack(true);
		await h.broker.idle();
		expect(h.edits()).toHaveLength(1);
		h.prompt(); h.ack(false);
		await h.broker.idle();
		expect(h.edits()).toHaveLength(1);
	});

	test("broker takeover retains editable notices; old socket cannot resolve them", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "final", text: "retained" });
		await h.broker.idle();
		h.broker.dispose();
		const next = harness(JSON.parse(JSON.stringify(h.state)));
		next.broker.handleClientMessage(h.owner, { t: "resolve", sessionId: "s", scope: "answer" });
		await next.broker.idle();
		expect(next.edits()).toHaveLength(0);
		next.client({ t: "resolve", scope: "answer" });
		await next.broker.idle();
		expect(next.edits()[0]!.params).toMatchObject({ message_id: 10, text: "☑️ Ответ получен · обсуждение продолжено\n\nretained" });
	});

	test("HTML failures fall back once, edit failures are logged and can retry", async () => {
		const h = harness();
		let sendFailure = true;
		let editFailure = true;
		h.intercept(async ({ method }) => {
			if (method === "sendMessage" && sendFailure) { sendFailure = false; throw new TelegramApiError(method, 400, "can't parse entities"); }
			if (method === "editMessageText" && editFailure) { editFailure = false; throw new TelegramApiError(method, 500, "temporary failure"); }
		});
		h.client({ t: "notify", kind: "final", text: "**bold**" });
		h.client({ t: "resolve", scope: "answer" });
		await h.broker.idle();
		expect(h.sends()[1]!.params).toMatchObject({ text: "✅ bold" });
		expect(h.sends()[1]!.params.parse_mode).toBeUndefined();
		expect(h.warnings).toEqual(["notification-format-fallback", "notification-edit-failed"]);
		expect(h.state.topics.s!.notifications).toHaveLength(1);
		h.client({ t: "resolve", scope: "answer" });
		await h.broker.idle();
		expect(h.edits()[1]!.params.text).toBe("☑️ Ответ получен · обсуждение продолжено\n\nbold");
		expect(h.state.topics.s!.notifications).toEqual([]);
	});

	test("attachments and previews exclude service blocks; service-only messages are suppressed", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "final", text: "```pix-actions\n- Done\n```" });
		await h.broker.idle();
		expect(h.sends()).toHaveLength(0);
		h.client({ t: "notify", kind: "final", text: `${"Long answer ".repeat(1500)}\n\n\`\`\`pix-actions Apply\n- [x] hidden\n\`\`\`` });
		await h.broker.idle();
		const document = h.calls.find((call) => call.method === "sendDocument")!.params.document as Blob;
		expect(await document.text()).not.toContain("pix-actions");
		expect(await document.text()).not.toContain("hidden");
		expect(h.sends()[0]!.params.text).not.toContain("pix-actions");
	});

	test("permanently uneditable messages are logged once and forgotten, not retried forever", async () => {
		for (const description of ["message to edit not found", "message can't be edited", "MESSAGE_ID_INVALID", "message is not modified"]) {
			const h = harness();
			h.intercept(async ({ method }) => { if (method === "editMessageText") throw new TelegramApiError(method, 400, description); });
			h.client({ t: "notify", kind: "final", text: "old" });
			h.client({ t: "resolve", scope: "answer" });
			await h.broker.idle();
			expect(h.state.topics.s!.notifications).toEqual([]);
			h.client({ t: "resolve", scope: "answer" });
			await h.broker.idle();
			expect(h.edits()).toHaveLength(1);
			expect(h.warnings).toHaveLength(description === "message is not modified" ? 0 : 1);
		}
	});

	test("continuing after an error or abort does not label it as an answer received", async () => {
		const h = harness();
		h.client({ t: "notify", kind: "error", text: "Request failed" });
		h.client({ t: "notify", kind: "aborted", text: "Stopped" });
		h.client({ t: "resolve", scope: "answer" });
		await h.broker.idle();
		for (const edit of h.edits()) {
			expect(edit.params.text).toContain("☑️ Обсуждение продолжено");
			expect(edit.params.text).not.toContain("Ответ получен");
		}
		expect(h.edits()).toHaveLength(2);
	});

	test("stale send completions cannot contaminate a different chat or disposed broker", async () => {
		for (const dispose of [false, true]) {
			const h = harness();
			await h.broker.idle();
			const entered = deferred(); const release = deferred();
			h.intercept(async ({ method }) => { if (method === "sendMessage") { entered.resolve(); await release.promise; } });
			h.client({ t: "notify", kind: "final", text: "old" });
			await entered.promise;
			if (dispose) h.broker.dispose();
			else h.broker.reconfigure({ chatId: -10088, allowedUserIds: [7] });
			release.resolve();
			await h.broker.idle();
			expect(h.state.topics.s?.notifications ?? []).toEqual([]);
			expect(h.edits()).toHaveLength(0);
		}
	});

	test("stale topic creation cannot replace the new chat's topic map", async () => {
		const h = harness();
		const entered = deferred(); const release = deferred();
		let first = true;
		h.intercept(async ({ method }) => {
			if (method === "createForumTopic" && first) { first = false; entered.resolve(); await release.promise; }
		});
		h.client({ t: "notify", kind: "final", text: "old chat only" });
		await entered.promise;
		h.broker.reconfigure({ chatId: -10088, allowedUserIds: [7] });
		release.resolve();
		await h.broker.idle();
		expect(h.calls.filter((call) => call.method === "createForumTopic").map((call) => call.params.chat_id)).toEqual([CHAT, -10088]);
		expect(h.state.chatId).toBe(-10088);
		expect(h.sends()).toHaveLength(0);
	});
});
