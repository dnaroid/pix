const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_TELEGRAM_TEXT = 4000;
const POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1000;

export type TelegramBotClientOptions = {
	sendTimeoutMs?: number;
	pollRequestTimeoutMs?: number;
};

export type TelegramIncomingMessage = {
	messageId: number;
	chatId: string;
	text: string;
	replyToMessageId?: number;
};

type TelegramUpdate = {
	update_id?: unknown;
	message?: {
		message_id?: unknown;
		chat?: { id?: unknown };
		text?: unknown;
		reply_to_message?: { message_id?: unknown };
	};
};

type TelegramApiResponse<T> = {
	ok?: unknown;
	result?: T;
	description?: unknown;
};

export type TelegramFetch = typeof fetch;

export class TelegramBotClient {
	private running = false;
	private abortController: AbortController | undefined;
	private nextOffset: number | undefined;

	constructor(
		private readonly botToken: string,
		private readonly chatId: string,
		private readonly fetchFn: TelegramFetch = fetch,
		private readonly options: TelegramBotClientOptions = {},
	) {}

	start(
		onMessage: (message: TelegramIncomingMessage) => void | Promise<void>,
		onError: (error: Error) => void = () => {},
	): void {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		void this.pollLoop(onMessage, onError, this.abortController.signal);
	}

	stop(): void {
		this.running = false;
		this.abortController?.abort();
		this.abortController = undefined;
	}

	async sendMessage(text: string, signal?: AbortSignal): Promise<number> {
		try {
			const body = await this.call<{ message_id?: unknown }>("sendMessage", {
				chat_id: this.chatId,
				text: trimTelegramText(text),
				disable_web_page_preview: true,
			}, signal);
			if (!body || typeof body.message_id !== "number") throw new Error("Telegram sendMessage returned no message id");
			return body.message_id;
		} catch (error) {
			throw this.sanitizeError(error);
		}
	}

	private async pollLoop(
		onMessage: (message: TelegramIncomingMessage) => void | Promise<void>,
		onError: (error: Error) => void,
		signal: AbortSignal,
	): Promise<void> {
		let failures = 0;
		let baselineReady = false;
		while (this.running && !signal.aborted) {
			try {
				if (!baselineReady) {
					const pending = await this.call<TelegramUpdate[]>("getUpdates", {
						offset: -1,
						limit: 1,
						timeout: 0,
						allowed_updates: ["message"],
					}, signal);
					const latestUpdateId = pending
						?.map((update) => update.update_id)
						.filter((updateId): updateId is number => typeof updateId === "number")
						.at(-1);
					if (latestUpdateId !== undefined) this.nextOffset = latestUpdateId + 1;
					baselineReady = true;
					failures = 0;
					continue;
				}
				const updates = await this.call<TelegramUpdate[]>("getUpdates", {
					...(this.nextOffset === undefined ? {} : { offset: this.nextOffset }),
					timeout: POLL_TIMEOUT_SECONDS,
					allowed_updates: ["message"],
				}, signal);
				failures = 0;
				for (const update of updates ?? []) {
					if (typeof update.update_id === "number") this.nextOffset = update.update_id + 1;
					const message = normalizeIncomingMessage(update);
					if (!message || message.chatId !== this.chatId) continue;
					await onMessage(message);
				}
			} catch (error) {
				if (signal.aborted || !this.running) return;
				failures += 1;
				onError(this.sanitizeError(error));
				await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6)), signal);
			}
		}
	}

	private sanitizeError(error: unknown): Error {
		const message = asError(error).message.replaceAll(this.botToken, "[redacted]");
		return new Error(message);
	}

	private async call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T | undefined> {
		const requestSignal = combineAbortSignals(
			[
				signal,
				this.abortController?.signal,
			],
			method === "getUpdates"
				? this.options.pollRequestTimeoutMs ?? DEFAULT_POLL_REQUEST_TIMEOUT_MS
				: this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
		);
		const response = await this.fetchFn(`${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: requestSignal,
		});
		let parsed: TelegramApiResponse<T> | undefined;
		try {
			parsed = await response.json() as TelegramApiResponse<T>;
		} catch {
			// Fall through to the sanitized HTTP error below.
		}
		if (!response.ok || parsed?.ok !== true) {
			const description = typeof parsed?.description === "string" ? `: ${parsed.description}` : "";
			throw new Error(`Telegram ${method} failed (${response.status})${description}`);
		}
		return parsed.result;
	}
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>, timeoutMs: number): AbortSignal {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	active.push(AbortSignal.timeout(Math.max(1, timeoutMs)));
	return active.length === 1 ? active[0]! : AbortSignal.any(active);
}

export function normalizeIncomingMessage(update: TelegramUpdate): TelegramIncomingMessage | undefined {
	const message = update.message;
	if (!message || typeof message.message_id !== "number" || typeof message.text !== "string") return undefined;
	const rawChatId = message.chat?.id;
	if (typeof rawChatId !== "number" && typeof rawChatId !== "string") return undefined;
	const text = message.text.trim();
	if (!text) return undefined;
	const rawReplyId = message.reply_to_message?.message_id;
	return {
		messageId: message.message_id,
		chatId: String(rawChatId),
		text,
		...(typeof rawReplyId === "number" ? { replyToMessageId: rawReplyId } : {}),
	};
}

export function trimTelegramText(text: string): string {
	if (text.length <= MAX_TELEGRAM_TEXT) return text;
	return `${text.slice(0, MAX_TELEGRAM_TEXT - 2)}…`;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
