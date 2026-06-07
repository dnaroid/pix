/**
 * Streaming-aware message renderer.
 *
 * Pipeline:
 *   pix events → renderer.push(text|tool|thinking|status)
 *               → accumulate chunks in arrival order
 *               → coalesce consecutive same-kind same-name tool events into ×N
 *               → throttled (~1.2 s) editMessageText flushes, paginated on overflow
 *               → on turn_end, flush remainder
 *
 * Tools render name-only (no args, no result). Thinking renders a single
 * `💭 thinking…` marker per turn. Tool-name batching reduces spam when
 * the agent fires many small tools in a row (e.g. 10× read).
 */

import { chunkForTelegram, markdownToTelegram, TELEGRAM_MESSAGE_MAX } from "./format.js";
import type { TelegramBot } from "./bot.js";

const THROTTLE_MS = 1200;

export type RendererEvent =
	| { kind: "turn_start" }
	| { kind: "assistant_text"; delta: string }
	| { kind: "thinking" }
	| { kind: "tool_start"; toolCallId: string; toolName: string }
	| { kind: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
	| { kind: "turn_end"; reason: "end" | "error" | "aborted" }
	| { kind: "info"; text: string };

type ToolStatus = "running" | "done" | "error";

interface ToolEntry {
	kind: "tool";
	status: ToolStatus;
	name: string;
	count: number;
}

interface TextEntry {
	kind: "text";
	content: string;
}

type Chunk = TextEntry | ToolEntry;

interface ActiveMessage {
	messageId: number;
	body: string;
}

export class TurnRenderer {
	private active: ActiveMessage | undefined;
	private chunks: Chunk[] = [];
	private thinkingShown = false;
	private scheduledFlush: ReturnType<typeof setTimeout> | undefined;
	private readonly sentMessageIds: number[] = [];

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
				this.reset();
				return;
			case "assistant_text":
				if (!event.delta) return;
				this.appendText(event.delta);
				this.scheduleFlush();
				return;
			case "thinking":
				if (this.thinkingShown) return;
				this.thinkingShown = true;
				this.appendText("\n💭 thinking…\n");
				this.scheduleFlush();
				return;
			case "tool_start":
				this.appendTool("running", event.toolName);
				this.scheduleFlush();
				return;
			case "tool_end":
				this.appendTool(event.isError ? "error" : "done", event.toolName);
				this.scheduleFlush();
				return;
			case "info":
				this.appendText(`\nℹ️ ${event.text}\n`);
				this.scheduleFlush();
				return;
			case "turn_end":
				this.appendText(`\n— ${event.reason === "aborted" ? "aborted" : event.reason === "error" ? "error" : "done"} —\n`);
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
		this.thinkingShown = false;
		this.active = undefined;
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

	private appendTool(status: ToolStatus, name: string): void {
		const last = this.chunks[this.chunks.length - 1];
		if (last && last.kind === "tool" && last.status === status && last.name === name) {
			last.count += 1;
		} else {
			this.chunks.push({ kind: "tool", status, name, count: 1 });
		}
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
			if (!this.active) {
				const sent = await this.bot.sendMessage(chunks[0]);
				if (sent?.message_id) {
					this.active = { messageId: sent.message_id, body: chunks[0] };
					this.sentMessageIds.push(sent.message_id);
				}
				for (const chunk of chunks.slice(1)) {
					const spilled = await this.bot.sendMessage(chunk);
					if (spilled?.message_id) {
						this.active = { messageId: spilled.message_id, body: chunk };
						this.sentMessageIds.push(spilled.message_id);
					}
				}
			} else {
				await this.bot.editMessageText(this.active.messageId, chunks[0]);
				this.active.body = chunks[0];
				for (const chunk of chunks.slice(1)) {
					const spilled = await this.bot.sendMessage(chunk);
					if (spilled?.message_id) {
						this.active = { messageId: spilled.message_id, body: chunk };
						this.sentMessageIds.push(spilled.message_id);
					}
				}
			}
		} catch (error) {
			this.logger(`telegram send failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private renderChunks(): string {
		let out = "";
		for (const chunk of this.chunks) {
			if (chunk.kind === "text") {
				out += chunk.content;
			} else {
				const icon = chunk.status === "running" ? "🔧" : chunk.status === "done" ? "✅" : "❌";
				const counter = chunk.count > 1 ? ` ×${chunk.count}` : "";
				out += `\n${icon} ${chunk.name}${counter}\n`;
			}
		}
		return out;
	}
}
