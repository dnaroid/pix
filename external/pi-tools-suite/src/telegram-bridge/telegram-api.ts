/** Minimal Telegram Bot API client (no SDK dependency). */

export interface TelegramUser { id: number; is_bot?: boolean }
export interface TelegramChat { id: number; type: string; is_forum?: boolean }
export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	is_topic_message?: boolean;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
	caption?: string;
}
export interface TelegramUpdate { update_id: number; message?: TelegramMessage }
export interface ForumTopic { message_thread_id: number; name: string }

export class TelegramApiError extends Error {
	override readonly name = "TelegramApiError";
	constructor(
		readonly method: string,
		readonly code: number,
		readonly description: string,
		readonly retryAfterSeconds?: number,
	) {
		super(`Telegram ${method} failed (${code}): ${description}`);
	}

	get threadMissing(): boolean {
		return this.code === 400 && /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(this.description);
	}
	get topicNotModified(): boolean {
		return this.code === 400 && /TOPIC_NOT_MODIFIED|not modified/i.test(this.description);
	}
}

export type TelegramCall = <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

/** Allowed forum topic icon colors (Bot API createForumTopic). */
export const TOPIC_ICON_COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F] as const;

export function createTelegramCall(token: string, fetchImpl: typeof fetch = fetch, baseUrl = "https://api.telegram.org"): TelegramCall {
	return async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
		// Documents need multipart; everything else is plain JSON.
		const multipart = Object.values(params).some((value) => value instanceof Blob);
		let body: BodyInit;
		const headers: Record<string, string> = {};
		if (multipart) {
			const form = new FormData();
			for (const [key, value] of Object.entries(params)) {
				if (value === undefined) continue;
				if (value instanceof Blob) form.append(key, value, key === "document" ? "answer.md" : key);
				else form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
			}
			body = form;
		} else {
			headers["content-type"] = "application/json";
			body = JSON.stringify(params);
		}
		const response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
			method: "POST",
			headers,
			body,
			...(signal ? { signal } : {}),
		});
		let payload: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
		try {
			payload = await response.json() as typeof payload;
		} catch {
			throw new TelegramApiError(method, response.status, "non-JSON response");
		}
		if (!payload.ok) {
			throw new TelegramApiError(
				method,
				payload.error_code ?? response.status,
				typeof payload.description === "string" ? payload.description.slice(0, 300) : "unknown error",
				payload.parameters?.retry_after,
			);
		}
		return payload.result as T;
	};
}

/**
 * Serializes outbound calls (groups allow ~20 messages/minute) and honors
 * 429 retry_after. Polling uses the raw call and is never queued.
 */
export class TelegramSendQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly call: TelegramCall,
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		private readonly maxAttempts = 4,
	) {}

	run<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const next = this.tail.then(() => this.attempt<T>(method, params));
		this.tail = next.catch(() => {});
		return next;
	}

	dispose(): void { this.disposed = true; }

	private async attempt<T>(method: string, params: Record<string, unknown>): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			if (this.disposed) throw new Error("Telegram send queue disposed");
			try {
				return await this.call<T>(method, params);
			} catch (error) {
				const retryAfter = error instanceof TelegramApiError && error.code === 429 ? error.retryAfterSeconds ?? 5 : undefined;
				if (retryAfter === undefined || attempt >= this.maxAttempts) throw error;
				await this.sleep(Math.min(retryAfter, 120) * 1000);
			}
		}
	}
}
