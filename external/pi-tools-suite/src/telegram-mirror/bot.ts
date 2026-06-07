/**
 * Minimal Telegram Bot API client.
 *
 * Uses native fetch (Node 18+ / Bun) and long polling via getUpdates.
 * No dependencies on grammY or node-telegram-bot-api.
 *
 * Provides:
 *   - sendMessage / editMessageText (HTML parse mode)
 *   - getUpdates long-poll loop with backoff
 *   - Auth gate by chat_id (single whitelist)
 *   - Graceful shutdown via AbortController
 */

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		date: number;
		chat: { id: number; type: string };
		from?: { id: number; first_name?: string; username?: string };
		text?: string;
	};
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number };
	date: number;
	text?: string;
}

export interface BotConfig {
	token: string;
	allowedChatId: number;
	timeoutMs?: number;
}

interface SendOptions {
	parseMode?: "HTML" | "MarkdownV2" | "Markdown";
	disablePreview?: boolean;
	silent?: boolean;
	replyToMessageId?: number;
}

interface EditOptions {
	parseMode?: "HTML" | "MarkdownV2" | "Markdown";
	disablePreview?: boolean;
}

export class TelegramBot {
	private readonly baseUrl: string;
	private readonly allowedChatId: number;
	private readonly timeoutMs: number;
	private readonly controller = new AbortController();
	private polling = false;
	private lastUpdateId = 0;
	private consecutiveErrors = 0;

	constructor(config: BotConfig) {
		if (!config.token) throw new Error("TelegramBot: token is required");
		this.baseUrl = `https://api.telegram.org/bot${config.token}`;
		this.allowedChatId = config.allowedChatId;
		this.timeoutMs = config.timeoutMs ?? 35_000;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get chatId(): number {
		return this.allowedChatId;
	}

	isAllowedChat(chatId: number): boolean {
		return chatId === this.allowedChatId;
	}

	async getMe(): Promise<{ ok: boolean; result?: { username: string; first_name: string } }> {
		return this.requestJson("GET", "getMe", undefined);
	}

	async sendMessage(text: string, options: SendOptions = {}): Promise<TelegramMessage | undefined> {
		return this.requestJson("POST", "sendMessage", {
			chat_id: this.allowedChatId,
			text,
			parse_mode: options.parseMode ?? "HTML",
			disable_web_page_preview: options.disablePreview ?? true,
			disable_notification: options.silent ?? false,
			...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId } : {}),
		});
	}

	async editMessageText(messageId: number, text: string, options: EditOptions = {}): Promise<TelegramMessage | undefined> {
		try {
			return await this.requestJson("POST", "editMessageText", {
				chat_id: this.allowedChatId,
				message_id: messageId,
				text,
				parse_mode: options.parseMode ?? "HTML",
				disable_web_page_preview: options.disablePreview ?? true,
			});
		} catch (error) {
			// Telegram returns 400 "message is not modified" if content is identical.
			// Treat that as success; surface everything else.
			const message = error instanceof Error ? error.message : String(error);
			if (/not modified/i.test(message)) return undefined;
			throw error;
		}
	}

	async deleteMessage(messageId: number): Promise<void> {
		try {
			await this.requestJson("POST", "deleteMessage", {
				chat_id: this.allowedChatId,
				message_id: messageId,
			});
		} catch {
			// best-effort
		}
	}

	/**
	 * Start long-polling loop. The callback receives every update from the
	 * allowed chat; updates from other chats are dropped silently.
	 *
	 * The loop exits cleanly when abort() is called.
	 */
	startPolling(onUpdate: (update: TelegramUpdate) => void | Promise<void>): void {
		if (this.polling) return;
		this.polling = true;
		void this.pollLoop(onUpdate);
	}

	abort(): void {
		if (this.controller.signal.aborted) return;
		this.controller.abort();
		this.polling = false;
	}

	private async pollLoop(onUpdate: (update: TelegramUpdate) => void | Promise<void>): Promise<void> {
		while (this.polling && !this.controller.signal.aborted) {
			try {
				const payload = await this.requestJson<{
					ok: boolean;
					result?: TelegramUpdate[];
				}>("POST", "getUpdates", {
					offset: this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined,
					timeout: Math.floor(this.timeoutMs / 1000),
					allowed_updates: ["message"],
				});

				this.consecutiveErrors = 0;

				if (!payload?.ok || !Array.isArray(payload.result)) {
					continue;
				}

				for (const update of payload.result) {
					if (update.update_id > this.lastUpdateId) this.lastUpdateId = update.update_id;
					if (!update.message) continue;
					if (!this.isAllowedChat(update.message.chat.id)) continue;
					try {
						await onUpdate(update);
					} catch (handlerError) {
						this.logError("onUpdate handler", handlerError);
					}
				}
			} catch (error) {
				if (this.controller.signal.aborted) break;
				this.consecutiveErrors += 1;
				this.logError("polling", error);
				// Backoff: 1s → 60s capped
				const backoff = Math.min(60_000, 1000 * 2 ** Math.min(5, this.consecutiveErrors - 1));
				await sleep(backoff).catch(() => undefined);
			}
		}
	}

	private async requestJson<T>(method: "GET" | "POST", endpoint: string, body?: Record<string, unknown>): Promise<T> {
		const url = `${this.baseUrl}/${endpoint}`;
		const init: RequestInit = {
			method,
			signal: this.controller.signal,
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(removeUndefined(body)) : undefined,
		};

		const response = await fetch(url, init);
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Telegram API ${endpoint} returned invalid JSON: ${text.slice(0, 200)}`);
		}

		if (!response.ok || (isRecord(parsed) && parsed.ok === false)) {
			const desc = isRecord(parsed) && typeof parsed.description === "string" ? parsed.description : text.slice(0, 200);
			const errorCode = isRecord(parsed) && typeof parsed.error_code === "number" ? parsed.error_code : response.status;
			throw new Error(`Telegram API ${endpoint} failed (${errorCode}): ${desc}`);
		}

		return parsed as T;
	}

	private logError(label: string, error: unknown): void {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		// Use stderr so we don't pollute the TUI. Pi redirects stderr to its log.
		// eslint-disable-next-line no-console
		console.error(`[telegram-mirror] ${label}: ${message}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
