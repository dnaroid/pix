/**
 * Pix event → TurnRenderer adapters.
 *
 * Keeps a per-turn renderer (one TG message chain per agent turn) and exposes
 * ExtensionAPI event handlers that append to it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RendererEvent } from "./renderer.js";

/**
 * Minimal sink for rendering events. The leader wires this to a Multiplexer
 * (which routes to a TurnRenderer for the active instance); a follower wires
 * it to an IPC socket so events travel to the leader.
 */
export interface RendererSink {
	push(event: RendererEvent): void;
}

export function registerPixEventHandlers(pi: ExtensionAPI, hooks: PixMirrorHooks): void {
	pi.on("agent_start", () => {
		hooks.getRenderer()?.push({ kind: "turn_start" });
	});

	pi.on("before_agent_start", (event) => {
		const prompt = event?.prompt?.trim();
		if (!prompt) return;
		hooks.getRenderer()?.push({ kind: "info", text: `user: ${truncate(prompt, 200)}` });
	});

	pi.on("message_update", (event) => {
		const type = event?.assistantMessageEvent?.type;
		if (type === "text_delta") {
			const delta = (event.assistantMessageEvent as { delta?: string }).delta ?? "";
			if (delta) hooks.getRenderer()?.push({ kind: "assistant_text", delta });
			return;
		}
		if (type === "thinking_delta" || type === "thinking_start") {
			// Render a single `💭 thinking…` marker per turn. The renderer
			// dedupes further thinking events so we don't spam the chat
			// with streaming thinking chunks.
			hooks.getRenderer()?.push({ kind: "thinking" });
			return;
		}
	});

	pi.on("tool_execution_start", (event) => {
		hooks.getRenderer()?.push({
			kind: "tool_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", (event) => {
		hooks.getRenderer()?.push({
			kind: "tool_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
	});

	pi.on("agent_end", () => {
		hooks.getRenderer()?.push({ kind: "turn_end", reason: "end" });
		hooks.notifyAgentEnd();
	});
}

export interface PixMirrorHooks {
	getRenderer(): RendererSink | undefined;
	notifyAgentEnd(): void;
}

export function captureAbortableContext(ctx: ExtensionContext | undefined, hooks: ContextCapture): void {
	if (!ctx) return;
	hooks.captureAbort(() => ctx.abort());
	hooks.captureIdle(() => ctx.isIdle());
	hooks.capturePending(() => ctx.hasPendingMessages());
	hooks.captureCompact(() => ctx.compact());
}

export interface ContextCapture {
	captureAbort(fn: () => void): void;
	captureIdle(fn: () => boolean): void;
	capturePending(fn: () => boolean): void;
	captureCompact(fn: () => void): void;
}

function truncate(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}
