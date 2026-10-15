/**
 * Coalesces streamed `session/update` notifications of one ACP session.
 *
 * Providers emit one pi delta per token; translated 1:1 this produced one
 * JSON-RPC notification (envelope, stdout line, IPC hop, parse) per token.
 * Updates pushed within one synchronous burst (e.g. several pi stdout lines
 * parsed in one read) are merged and sent at the end of the current
 * microtask, so coalescing adds no timer latency:
 *
 * - adjacent text chunks of the same kind/message concatenate (append
 *   semantics, identical reducer result);
 * - adjacent partial `tool_call_update`s of the same tool call (content
 *   only, replace semantics) keep only the latest.
 *
 * Ordering: pending updates are flushed synchronously before any other
 * notification of the session (see {@link SessionUpdateCoalescer.flush}),
 * before prompt settlement, and before non-streaming updates, so merging
 * never reorders protocol messages.
 */

import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

export type SessionUpdateSender = (notification: SessionNotification) => void;

export class SessionUpdateCoalescer {
	private pending: SessionNotification[] = [];
	private scheduled = false;
	private disposed = false;

	constructor(private readonly send: SessionUpdateSender) {}

	/** Queue a streamed update; non-streaming updates flush immediately. */
	push(notification: SessionNotification): void {
		if (this.disposed) return;
		const last = this.pending.at(-1);
		const merged = last ? mergeNotifications(last, notification) : undefined;
		if (merged) this.pending[this.pending.length - 1] = merged;
		else this.pending.push(notification);
		if (!isStreamingUpdate(notification.update)) {
			this.flush();
			return;
		}
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				this.scheduled = false;
				this.flush();
			});
		}
	}

	/** Send all pending updates in order. Safe to call at any time. */
	flush(): void {
		if (this.pending.length === 0) return;
		const batch = this.pending;
		this.pending = [];
		for (const notification of batch) this.send(notification);
	}

	/** Flush what is pending and stop accepting updates. */
	dispose(): void {
		if (this.disposed) return;
		this.flush();
		this.disposed = true;
	}
}

type TextChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>;

function isTextChunk(update: SessionUpdate): update is TextChunkUpdate {
	return (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")
		&& update.content.type === "text"
		&& update._meta == null;
}

/** A content-only progress update (no status/output/locations change). */
function isPartialToolUpdate(update: SessionUpdate): boolean {
	if (update.sessionUpdate !== "tool_call_update") return false;
	return Object.keys(update).every((key) => key === "sessionUpdate" || key === "toolCallId" || key === "content");
}

function isStreamingUpdate(update: SessionUpdate): boolean {
	return isTextChunk(update) || isPartialToolUpdate(update);
}

export function mergeNotifications(
	previous: SessionNotification,
	next: SessionNotification,
): SessionNotification | undefined {
	if (previous.sessionId !== next.sessionId || previous._meta != null || next._meta != null) return undefined;
	const a = previous.update;
	const b = next.update;
	if (isTextChunk(a) && isTextChunk(b) && a.sessionUpdate === b.sessionUpdate
		&& (a.messageId ?? undefined) === (b.messageId ?? undefined)
		&& a.content.type === "text" && b.content.type === "text") {
		return {
			sessionId: previous.sessionId,
			update: { ...a, content: { ...a.content, text: a.content.text + b.content.text } },
		};
	}
	if (isPartialToolUpdate(a) && isPartialToolUpdate(b)
		&& a.sessionUpdate === "tool_call_update" && b.sessionUpdate === "tool_call_update"
		&& a.toolCallId === b.toolCallId) {
		return next;
	}
	return undefined;
}
