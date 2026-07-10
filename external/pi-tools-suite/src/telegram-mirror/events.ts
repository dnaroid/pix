/**
 * Pix event → TurnRenderer adapters.
 *
 * Keeps a per-turn renderer (one TG message chain per agent turn) and exposes
 * ExtensionAPI event handlers that append to it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RendererEvent, RendererInstance } from "./renderer.js";

/**
 * Minimal sink for rendering events. The leader wires this to a Multiplexer
 * (which routes to a TurnRenderer for the active instance); a follower wires
 * it to an IPC socket so events travel to the leader.
 */
export interface RendererSink {
	push(event: RendererEvent): void;
}

export function registerPixEventHandlers(pi: ExtensionAPI, hooks: PixMirrorHooks): void {
	let turnActive = false;

	pi.on("agent_start", (_event, ctx) => {
		if (turnActive) return;
		turnActive = true;
		hooks.getRenderer()?.push({ kind: "turn_start", instance: hooks.describeInstance(ctx as ExtensionContext | undefined) });
	});

	pi.on("message_update", (event) => {
		const type = event?.assistantMessageEvent?.type;
		if (type === "text_delta") {
			const delta = (event.assistantMessageEvent as { delta?: string }).delta ?? "";
			if (delta) hooks.getRenderer()?.push({ kind: "assistant_text", delta });
			return;
		}
		// Ignore thinking and toolcall events. Telegram mirrors only the
		// user-visible assistant answer, not internal reasoning/tools.
	});

	pi.on("agent_settled", () => {
		if (!turnActive) return;
		turnActive = false;
		hooks.getRenderer()?.push({ kind: "turn_end", reason: "end" });
		hooks.notifyAgentSettled();
	});
}

export interface PixMirrorHooks {
	getRenderer(): RendererSink | undefined;
	describeInstance(ctx: ExtensionContext | undefined): RendererInstance | undefined;
	notifyAgentSettled(): void;
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
