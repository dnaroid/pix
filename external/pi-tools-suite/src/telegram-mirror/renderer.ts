/**
 * Streaming-aware message renderer.
 *
 * Pipeline:
 *   pix events → renderer.push(assistant_text|status)
 *               → accumulate assistant-visible text only
 *               → throttled (~1.2 s) editMessageText flushes, paginated on overflow
 *               → on turn_end, flush remainder
 *
 * Tool calls/results and thinking deltas are intentionally ignored: Telegram
 * is a second screen for user-visible assistant messages, not a debug log.
 */

import { chunkForTelegram, markdownToTelegram, TELEGRAM_MESSAGE_MAX } from "./format.js";
import type { TelegramBot } from "./bot.js";

const THROTTLE_MS = 1200;
const SESSION_SEPARATOR = "\n\n━━━━━━━━━━━━\n\n";

export type RendererEvent =
	| { kind: "turn_start"; instance?: RendererInstance }
	| { kind: "assistant_text"; delta: string }
	| { kind: "turn_end"; reason: "end" | "error" | "aborted" };

export interface RendererInstance {
	label: string;
	cwd?: string;
	sessionName?: string;
	sessionId?: string;
}

interface TextEntry {
	kind: "text";
	content: string;
}

type Chunk = TextEntry;

interface ActiveMessage {
	messageId: number;
	body: string;
}

interface SentPage {
	messageId: number;
	body: string;
}

export class TurnRenderer {
	private active: ActiveMessage | undefined;
	private chunks: Chunk[] = [];
	private header: string | undefined;
	private scheduledFlush: ReturnType<typeof setTimeout> | undefined;
	private readonly sentMessageIds: number[] = [];
	private pages: SentPage[] = [];
	private turnHasText = false;
	private turnOpen = false;

	constructor(
		private readonly bot: TelegramBot,
		private readonly logger: (msg: string) => void = () => undefined,
	) {}

	get sentIds(): readonly number[] {
		return this.sentMessageIds;
	}

	push(event: RendererEvent): void {
		switch (event.kind) {
			case "turn_start":
				this.startTurn(event.instance);
				this.header = renderHeader(event.instance);
				return;
			case "assistant_text":
				if (!event.delta) return;
				if (!this.turnOpen) this.startTurn(undefined);
				this.turnHasText = true;
				this.appendText(event.delta);
				this.scheduleFlush();
				return;
			case "turn_end":
				if (this.turnHasText) {
					this.appendText(`\n\n— ${event.reason === "aborted" ? "aborted" : event.reason === "error" ? "error" : "done"} —\n`);
				}
				this.turnOpen = false;
				void this.flushNow();
				return;
		}
	}

	/** Force an immediate flush. */
	async flushNow(): Promise<void> {
		if (this.scheduledFlush) {
			clearTimeout(this.scheduledFlush);
			this.scheduledFlush = undefined;
		}
		await this.flushPending();
	}

	/** Drop everything without flushing (e.g. for cleanup). */
	reset(): void {
		if (this.scheduledFlush) {
			clearTimeout(this.scheduledFlush);
			this.scheduledFlush = undefined;
		}
		this.chunks = [];
		this.header = undefined;
		this.active = undefined;
		this.pages = [];
		this.turnHasText = false;
		this.turnOpen = false;
	}

	/** Replace the current Telegram-rendered buffer with a session transcript. */
	async showTranscript(instance: RendererInstance | undefined, transcript: string): Promise<void> {
		this.reset();
		this.header = renderHeader(instance);
		const trimmed = transcript.trim();
		if (!trimmed) return;
		this.chunks = [{ kind: "text", content: trimmed }];
		await this.flushNow();
	}

	/** Update the most recent message with [aborted] trailer. */
	async markAborted(): Promise<void> {
		if (!this.active) return;
		try {
			await this.bot.editMessageText(this.active.messageId, `${this.active.body}\n\n[aborted]`);
		} catch {
			// best-effort
		}
	}

	// ─── Internals ───────────────────────────────────────────────────────

	private appendText(delta: string): void {
		const last = this.chunks[this.chunks.length - 1];
		if (last && last.kind === "text") {
			last.content += delta;
		} else {
			this.chunks.push({ kind: "text", content: delta });
		}
	}

	private startTurn(instance: RendererInstance | undefined): void {
		if (this.turnOpen) return;
		if (!this.header) this.header = renderHeader(instance);
		if (this.chunks.length > 0) this.appendText(SESSION_SEPARATOR);
		this.turnHasText = false;
		this.turnOpen = true;
	}

	private scheduleFlush(): void {
		if (this.scheduledFlush) return;
		this.scheduledFlush = setTimeout(() => {
			this.scheduledFlush = undefined;
			void this.flushPending().catch((error) => {
				this.logger(`flush failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, THROTTLE_MS);
	}

	private async flushPending(): Promise<void> {
		const body = this.renderChunks();
		if (!body) return;

		const html = markdownToTelegram(body);

		const chunks = chunkForTelegram(html, TELEGRAM_MESSAGE_MAX - 32);
		if (chunks.length === 0) return;

		try {
			for (let idx = 0; idx < chunks.length; idx += 1) {
				const chunk = chunks[idx];
				const page = this.pages[idx];
				if (page) {
					if (page.body !== chunk) {
						await this.bot.editMessageText(page.messageId, chunk);
						page.body = chunk;
					}
					continue;
				}
				const sent = await this.bot.sendMessage(chunk);
				if (sent?.message_id) {
					const next = { messageId: sent.message_id, body: chunk };
					this.pages.push(next);
					this.sentMessageIds.push(sent.message_id);
				}
			}
			this.active = this.pages[this.pages.length - 1];
		} catch (error) {
			this.logger(`telegram send failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private renderChunks(): string {
		let out = this.header ? `${this.header}\n\n` : "";
		for (const chunk of this.chunks) {
			out += chunk.content;
		}
		return out;
	}
}

function renderHeader(instance: RendererInstance | undefined): string | undefined {
	if (!instance) return undefined;
	const bits = [instance.label];
	if (instance.sessionName) bits.push(instance.sessionName);
	else if (instance.sessionId) bits.push(instance.sessionId.slice(0, 8));
	return `🤖 ${bits.join(" · ")}`;
}
