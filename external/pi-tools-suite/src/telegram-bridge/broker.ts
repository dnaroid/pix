import { MAX_INLINE_CHUNKS, notifyPrefix, parseCommand, projectIconColor, splitMessage, topicLink, topicName } from "./format.js";
import type { BrokerMessage, ClientMessage } from "./protocol.js";
import { TelegramApiError, type ForumTopic, type TelegramMessage, type TelegramUpdate } from "./telegram-api.js";

export interface BrokerConnection {
	send(message: BrokerMessage): void;
}

export interface TopicRecord {
	threadId: number;
	name: string;
	closed: boolean;
	updatedAt: number;
}

export interface BrokerState {
	offset: number;
	topics: Record<string, TopicRecord>;
}

type ReportFields = Record<string, string | number | boolean>;

export interface BrokerDeps {
	/** Undefined = setup mode: only /id is answered, in any chat. */
	chatId?: number;
	allowedUserIds: readonly number[];
	/** Queued Bot API call (rate-limit aware). */
	send: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
	state: BrokerState;
	saveState: () => void;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	report?: (level: "info" | "warn" | "error", event: string, fields?: ReportFields) => void;
	randomId?: () => string;
	closeGraceMs?: number;
}

interface LiveSession {
	sessionId: string;
	connection: BrokerConnection;
	project: string;
	cwd: string;
	title?: string;
}

interface PendingRequest {
	chatId: number;
	threadId: number;
	messageId: number;
}

const MAX_TOPICS = 1000;
const MAX_PENDING = 200;
export const DEFAULT_CLOSE_GRACE_MS = 15_000;

const HELP = [
	"Pix bridge: each running Pix session has its own topic here.",
	"",
	"In a session topic: write a message to send it to the agent.",
	"/stop – stop the current run",
	"/status – session state",
	"",
	"Anywhere: /sessions – running sessions by project, /id – chat and user ids.",
].join("\n");

function errorType(error: unknown): string {
	return error instanceof TelegramApiError ? "NetworkError" : error instanceof Error && error.name === "AbortError" ? "AbortError" : "OtherError";
}

/**
 * Routing core: one forum topic per Pix session (across every project and
 * window), Telegram messages to the owning session process, agent results back.
 * Pure of sockets/polling; the host feeds it connections and updates.
 */
export class TelegramBridgeBroker {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly closeTimers = new Map<string, unknown>();
	private readonly chains = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, PendingRequest>();
	private disposed = false;
	private sequence = 0;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly report: NonNullable<BrokerDeps["report"]>;

	constructor(private readonly deps: BrokerDeps) {
		this.now = deps.now ?? Date.now;
		this.setTimer = deps.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
		this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.report = deps.report ?? (() => {});
	}

	get liveSessionIds(): string[] {
		return [...this.sessions.keys()];
	}

	/** Resolves once every queued per-session Telegram operation has settled (tests/teardown). */
	async idle(): Promise<void> {
		while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
	}

	handleClientMessage(connection: BrokerConnection, message: ClientMessage): void {
		if (this.disposed) return;
		switch (message.t) {
			case "register": {
				this.cancelClose(message.sessionId);
				this.sessions.set(message.sessionId, {
					sessionId: message.sessionId,
					connection,
					project: message.project,
					cwd: message.cwd,
					...(message.title !== undefined ? { title: message.title } : {}),
				});
				this.serial(message.sessionId, () => this.ensureTopic(message.sessionId).then(() => undefined));
				return;
			}
			case "rename": {
				const session = this.sessions.get(message.sessionId);
				if (!session || session.connection !== connection || session.title === message.title) return;
				session.title = message.title;
				this.serial(message.sessionId, () => this.ensureTopic(message.sessionId).then(() => undefined));
				return;
			}
			case "unregister": {
				const session = this.sessions.get(message.sessionId);
				if (!session || session.connection !== connection) return;
				this.sessions.delete(message.sessionId);
				this.scheduleClose(message.sessionId);
				return;
			}
			case "notify": {
				const session = this.sessions.get(message.sessionId);
				if (!session || session.connection !== connection) return;
				const text = `${notifyPrefix(message.kind)}${message.text}`;
				this.serial(message.sessionId, () => this.deliver(message.sessionId, text));
				return;
			}
			case "ack": {
				const request = this.pending.get(message.requestId);
				if (!request) return;
				this.pending.delete(message.requestId);
				if (message.ok) {
					void this.deps.send("setMessageReaction", {
						chat_id: request.chatId,
						message_id: request.messageId,
						reaction: [{ type: "emoji", emoji: "👀" }],
					}).catch(() => {});
				} else {
					void this.reply(request.chatId, request.threadId, request.messageId, `⚠️ ${message.error ?? "Pix could not accept the message."}`);
				}
				return;
			}
		}
	}

	/** A dropped socket ends every session it owned (with a grace period for reloads/takeovers). */
	detach(connection: BrokerConnection): void {
		for (const [sessionId, session] of [...this.sessions]) {
			if (session.connection !== connection) continue;
			this.sessions.delete(sessionId);
			this.scheduleClose(sessionId);
		}
	}

	handleUpdate(update: TelegramUpdate): void {
		if (this.disposed) return;
		const message = update.message;
		if (!message?.from || message.from.is_bot) return;
		const text = (message.text ?? message.caption ?? "").trim();
		const command = parseCommand(text);
		const threadId = message.is_topic_message ? message.message_thread_id : undefined;

		if (command?.command === "id") {
			void this.reply(message.chat.id, threadId, message.message_id,
				`chat id: ${message.chat.id}${message.chat.is_forum ? " (forum)" : ""}\nyour user id: ${message.from.id}`);
			return;
		}
		if (this.deps.chatId === undefined || message.chat.id !== this.deps.chatId) return;
		if (!this.deps.allowedUserIds.includes(message.from.id)) {
			this.report("warn", "unauthorized-message");
			return;
		}
		this.handleAuthorized(message, text, command, threadId);
	}

	dispose(): void {
		this.disposed = true;
		for (const handle of this.closeTimers.values()) this.clearTimer(handle);
		this.closeTimers.clear();
		this.sessions.clear();
		this.pending.clear();
	}

	private handleAuthorized(
		message: TelegramMessage,
		text: string,
		command: ReturnType<typeof parseCommand>,
		threadId: number | undefined,
	): void {
		const chatId = message.chat.id;
		const sessionId = threadId === undefined ? undefined : this.sessionForThread(threadId);
		if (command?.command === "sessions") {
			void this.reply(chatId, threadId, message.message_id, this.sessionsOverview());
			return;
		}
		if (!sessionId) {
			void this.reply(chatId, threadId, message.message_id, command?.command === "help" || command?.command === "start"
				? HELP : `${HELP}\n\nThis topic is not linked to a Pix session.`);
			return;
		}
		if (command?.command === "help" || command?.command === "start") {
			void this.reply(chatId, threadId, message.message_id, HELP);
			return;
		}
		const live = this.sessions.get(sessionId);
		if (command?.command === "status") {
			void this.reply(chatId, threadId, message.message_id, live
				? `🟢 Running in ${live.cwd}` : "⚪️ Not running. Reopen the session in Pix to continue.");
			return;
		}
		if (!live) {
			void this.reply(chatId, threadId, message.message_id, "⚪️ This session is not running. Reopen it in Pix to continue.");
			return;
		}
		if (!text) {
			void this.reply(chatId, threadId, message.message_id, "Only text messages are supported.");
			return;
		}
		const requestId = `${this.now().toString(36)}-${(++this.sequence).toString(36)}${this.deps.randomId?.() ?? ""}`;
		this.pending.set(requestId, { chatId, threadId: threadId!, messageId: message.message_id });
		while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
		try {
			live.connection.send(command?.command === "stop"
				? { t: "stop", sessionId, requestId }
				: { t: "prompt", sessionId, requestId, text });
		} catch {
			this.pending.delete(requestId);
			void this.reply(chatId, threadId, message.message_id, "⚠️ The Pix session is unreachable right now.");
		}
	}

	private sessionForThread(threadId: number): string | undefined {
		for (const [sessionId, record] of Object.entries(this.deps.state.topics)) {
			if (record.threadId === threadId) return sessionId;
		}
		return undefined;
	}

	private sessionsOverview(): string {
		if (this.sessions.size === 0) return "No Pix sessions are running.";
		const byProject = new Map<string, LiveSession[]>();
		for (const session of this.sessions.values()) {
			const list = byProject.get(session.cwd) ?? [];
			list.push(session);
			byProject.set(session.cwd, list);
		}
		const lines: string[] = [];
		for (const [cwd, sessions] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`📁 ${sessions[0]!.project} (${cwd})`);
			for (const session of sessions) {
				const record = this.deps.state.topics[session.sessionId];
				const link = record && this.deps.chatId !== undefined ? topicLink(this.deps.chatId, record.threadId) : undefined;
				lines.push(`  • ${session.title?.trim() || "new session"}${link ? ` – ${link}` : ""}`);
			}
		}
		return lines.join("\n");
	}

	/** Per-session FIFO so topic creation, renames and messages never interleave. */
	private serial(sessionId: string, operation: () => Promise<void>): void {
		const previous = this.chains.get(sessionId) ?? Promise.resolve();
		const next = previous.then(async () => {
			if (this.disposed) return;
			try {
				await operation();
			} catch (error) {
				this.report("warn", "telegram-call-failed", { errorType: errorType(error) });
			}
		});
		this.chains.set(sessionId, next);
		void next.then(() => {
			if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
		});
	}

	private async ensureTopic(sessionId: string): Promise<number | undefined> {
		const chatId = this.deps.chatId;
		const session = this.sessions.get(sessionId);
		if (chatId === undefined || !session) return this.deps.state.topics[sessionId]?.threadId;
		const name = topicName(session.project, session.title);
		const record = this.deps.state.topics[sessionId];
		if (record) {
			try {
				if (record.closed) {
					await this.ignoreNotModified(this.deps.send("reopenForumTopic", { chat_id: chatId, message_thread_id: record.threadId }));
					record.closed = false;
				}
				if (record.name !== name) {
					await this.ignoreNotModified(this.deps.send("editForumTopic", { chat_id: chatId, message_thread_id: record.threadId, name }));
					record.name = name;
				}
				record.updatedAt = this.now();
				this.deps.saveState();
				return record.threadId;
			} catch (error) {
				if (!(error instanceof TelegramApiError && error.threadMissing)) throw error;
				delete this.deps.state.topics[sessionId];
			}
		}
		const topic = await this.deps.send<ForumTopic>("createForumTopic", { chat_id: chatId, name, icon_color: projectIconColor(session.cwd) });
		this.deps.state.topics[sessionId] = { threadId: topic.message_thread_id, name, closed: false, updatedAt: this.now() };
		this.pruneTopics();
		this.deps.saveState();
		return topic.message_thread_id;
	}

	private async ignoreNotModified(call: Promise<unknown>): Promise<void> {
		try {
			await call;
		} catch (error) {
			if (!(error instanceof TelegramApiError && error.topicNotModified)) throw error;
		}
	}

	private async deliver(sessionId: string, text: string): Promise<void> {
		const chatId = this.deps.chatId;
		if (chatId === undefined) return;
		for (let attempt = 0; attempt < 2; attempt++) {
			const threadId = await this.ensureTopic(sessionId);
			if (threadId === undefined) return;
			try {
				await this.sendText(chatId, threadId, text);
				return;
			} catch (error) {
				// The topic was deleted by hand: forget it and recreate once.
				if (attempt > 0 || !(error instanceof TelegramApiError && error.threadMissing)) throw error;
				delete this.deps.state.topics[sessionId];
			}
		}
	}

	private async sendText(chatId: number, threadId: number, text: string): Promise<void> {
		const chunks = splitMessage(text);
		if (chunks.length <= MAX_INLINE_CHUNKS) {
			for (const chunk of chunks) await this.deps.send("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: chunk });
			return;
		}
		await this.deps.send("sendMessage", { chat_id: chatId, message_thread_id: threadId, text: `${chunks[0]}\n\n… (full answer attached)` });
		await this.deps.send("sendDocument", {
			chat_id: chatId,
			message_thread_id: threadId,
			document: new Blob([text], { type: "text/markdown" }),
		});
	}

	private async reply(chatId: number, threadId: number | undefined, messageId: number, text: string): Promise<void> {
		try {
			await this.deps.send("sendMessage", {
				chat_id: chatId,
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
				text: splitMessage(text)[0],
				reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
			});
		} catch (error) {
			this.report("warn", "telegram-call-failed", { errorType: errorType(error) });
		}
	}

	private scheduleClose(sessionId: string): void {
		this.cancelClose(sessionId);
		const handle = this.setTimer(() => {
			this.closeTimers.delete(sessionId);
			if (this.sessions.has(sessionId)) return;
			this.serial(sessionId, () => this.closeTopic(sessionId));
		}, this.deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
		this.closeTimers.set(sessionId, handle);
	}

	private cancelClose(sessionId: string): void {
		const handle = this.closeTimers.get(sessionId);
		if (handle === undefined) return;
		this.clearTimer(handle);
		this.closeTimers.delete(sessionId);
	}

	private async closeTopic(sessionId: string): Promise<void> {
		const chatId = this.deps.chatId;
		const record = this.deps.state.topics[sessionId];
		// A re-registration may have raced in behind the timer.
		if (chatId === undefined || !record || record.closed || this.sessions.has(sessionId)) return;
		try {
			await this.deps.send("sendMessage", { chat_id: chatId, message_thread_id: record.threadId, text: "⚪️ Session closed in Pix." });
			await this.ignoreNotModified(this.deps.send("closeForumTopic", { chat_id: chatId, message_thread_id: record.threadId }));
		} catch (error) {
			if (!(error instanceof TelegramApiError && error.threadMissing)) throw error;
			delete this.deps.state.topics[sessionId];
			this.deps.saveState();
			return;
		}
		record.closed = true;
		record.updatedAt = this.now();
		this.deps.saveState();
	}

	private pruneTopics(): void {
		const entries = Object.entries(this.deps.state.topics);
		if (entries.length <= MAX_TOPICS) return;
		const removable = entries
			.filter(([sessionId, record]) => record.closed && !this.sessions.has(sessionId))
			.sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
		for (const [sessionId] of removable.slice(0, entries.length - MAX_TOPICS)) delete this.deps.state.topics[sessionId];
	}
}
