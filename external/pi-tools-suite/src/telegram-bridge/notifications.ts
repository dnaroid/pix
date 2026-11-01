import { MAX_INLINE_CHUNKS, notifyPrefix } from "./format.js";
import { cleanTelegramMarkdown, escapeHtml, telegramChunks } from "./message-format.js";
import type { NotifyKind, ResolveScope } from "./protocol.js";
import { TelegramApiError, type TelegramMessage } from "./telegram-api.js";

export interface NotificationRecord {
	messageId: number;
	kind: NotifyKind;
	generation: number;
	body: string;
	/** Missing means plain-text fallback. */
	parseMode?: "HTML";
}

export interface NotificationTopic { threadId: number; notifications?: NotificationRecord[] }
const MAX_TRACKED_NOTICES = 12;
export interface NotificationContext {
	chatId: number;
	topic: NotificationTopic;
	send: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
	/** Prevent stale completions from mutating a replaced topic/chat or disposed broker. */
	isCurrent: () => boolean;
	save: () => void;
	warn: (event: "notification-format-fallback" | "notification-edit-failed", error: unknown) => void;
}

function scopeOf(kind: NotifyKind): ResolveScope { return kind === "waiting" ? "waiting" : "answer"; }
function entityError(error: unknown): boolean {
	return error instanceof TelegramApiError && error.code === 400 && /parse entities|unsupported start tag|entity.*(?:end|offset)/i.test(error.description);
}

/** Bounded recent pending messages, retaining IDs/bodies across broker takeovers. */
export async function deliverNotification(context: NotificationContext, kind: NotifyKind, text: string, generation: number): Promise<void> {
	const clean = cleanTelegramMarkdown(text);
	if (!clean || !context.isCurrent()) return;
	const chunks = telegramChunks(clean);
	if (chunks.length === 0) return;
	const attached = chunks.length > MAX_INLINE_CHUNKS;
	const selected = attached ? chunks.slice(0, 1) : chunks;
	for (const chunk of selected) {
		if (!context.isCurrent()) return;
		let body = chunk.html + (attached ? "\n\n… (full answer attached)" : "");
		let parseMode: "HTML" | undefined = "HTML";
		const params = { chat_id: context.chatId, message_thread_id: context.topic.threadId };
		let message: TelegramMessage;
		try {
			message = await context.send<TelegramMessage>("sendMessage", { ...params, text: notifyPrefix(kind) + body, parse_mode: parseMode });
		} catch (error) {
			if (!entityError(error) || !context.isCurrent()) throw error;
			context.warn("notification-format-fallback", error);
			body = chunk.plain + (attached ? "\n\n… (full answer attached)" : "");
			parseMode = undefined;
			message = await context.send<TelegramMessage>("sendMessage", { ...params, text: notifyPrefix(kind) + body });
		}
		// A send crossing broker disposal may remain untracked. Never let the old
		// owner save late state over the new broker's snapshot just to retain its ID.
		if (!context.isCurrent()) return;
		if (Number.isSafeInteger(message?.message_id) && message.message_id > 0) {
			const notices = context.topic.notifications ?? [];
			notices.push({ messageId: message.message_id, kind, generation, body, ...(parseMode ? { parseMode } : {}) });
			context.topic.notifications = notices.slice(-MAX_TRACKED_NOTICES);
			context.save();
		}
	}
	if (attached && context.isCurrent()) await context.send("sendDocument", {
		chat_id: context.chatId, message_thread_id: context.topic.threadId,
		document: new Blob([clean], { type: "text/markdown" }),
	});
}

export async function resolveNotifications(context: NotificationContext, scope: ResolveScope, through: number): Promise<void> {
	const notices = context.topic.notifications ?? [];
	for (const notice of [...notices]) {
		if (!context.isCurrent()) return;
		if (scopeOf(notice.kind) !== scope || notice.generation > through) continue;
		const label = scope === "waiting" ? "☑️ Диалог закрыт" : notice.kind === "final"
			? "☑️ Ответ получен · обсуждение продолжено" : "☑️ Обсуждение продолжено";
		try {
			await context.send("editMessageText", {
				chat_id: context.chatId, message_id: notice.messageId,
				text: `${notice.parseMode ? escapeHtml(label) : label}\n\n${notice.body}`,
				...(notice.parseMode ? { parse_mode: notice.parseMode } : {}),
				reply_markup: { inline_keyboard: [] },
			});
		} catch (error) {
			const terminal = error instanceof TelegramApiError && error.messageNotEditable;
			if (terminal) context.warn("notification-edit-failed", error);
			if (!(error instanceof TelegramApiError && (error.topicNotModified || terminal))) {
				context.warn("notification-edit-failed", error);
				continue; // Retain for a later retry; do not prevent delivery of a new answer.
			}
		}
		if (!context.isCurrent()) return;
		context.topic.notifications = context.topic.notifications?.filter((candidate) => candidate !== notice);
		context.save();
	}
}

/** Validate bounded persisted metadata; legacy topics simply have no editable notices. */
export function loadNotifications(value: unknown): NotificationRecord[] {
	if (!Array.isArray(value)) return [];
	return value.slice(-MAX_TRACKED_NOTICES).filter((notice): notice is NotificationRecord => {
		if (!notice || typeof notice !== "object") return false;
		return Number.isSafeInteger(notice.messageId) && notice.messageId > 0
			&& ["final", "waiting", "aborted", "error"].includes(notice.kind)
			&& Number.isSafeInteger(notice.generation) && notice.generation >= 0
			&& typeof notice.body === "string" && notice.body.length <= 3500
			&& (notice.parseMode === undefined || notice.parseMode === "HTML");
	});
}
