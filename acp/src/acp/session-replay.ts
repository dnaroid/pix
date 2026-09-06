/**
 * Replays persisted pi session history as ACP `session/update` notifications
 * for `session/load`.
 *
 * ACP 1.4 has no dedicated history message: loaded conversations are
 * re-emitted as `user_message_chunk` / `agent_message_chunk` updates plus
 * `tool_call` / `tool_call_update` pairs for tool usage. Each message is sent
 * with stable ids derived from its index (`replay-<n>`), and tool calls reuse
 * the pi tool-call ids so clients correlate call and result.
 *
 * Thinking blocks are omitted (documented limitation); the conversation
 * itself remains fully intact inside pi.
 */

import type { SessionNotification, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { toolKind, toolLocations, toolTitle, type TranslateContext } from "./event-translator.js";
import type { PiAgentMessage, PiClient, PiMessagePart } from "../pi/pi-rpc-client.js";

export interface DeferredSessionHistory {
	readonly updates: readonly SessionUpdate[];
	readonly toolResults: ReadonlyMap<string, DeferredToolResult>;
}

export interface DeferredToolResult {
	readonly message: PiAgentMessage;
	readonly rawInput?: unknown;
}

export async function replaySessionHistory(
	pi: PiClient,
	context: TranslateContext,
	notify: (notification: SessionNotification) => Promise<void>,
): Promise<void> {
	const messages = await pi.getMessages();
	for (const [index, message] of messages.entries()) {
		const messageId = `replay-${index}`;
		// The loose catch-all variant of PiAgentMessage defeats discriminated
		// narrowing, so read the fields defensively per role at runtime.
		const content = (message as { content?: unknown }).content;
		if (message.role === "user") {
			if (typeof content === "string") {
				if (content) {
					await notify(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: content }));
				}
			} else if (Array.isArray(content)) {
				for (const part of content as readonly PiMessagePart[]) {
					if (part.type === "text" && typeof part.text === "string" && part.text) {
						await notify(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: part.text }));
					} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
						await notify(chunk(context.sessionId, messageId, "user_message_chunk", {
							type: "image",
							data: part.data,
							mimeType: part.mimeType,
						}));
					}
				}
			}
		} else if (message.role === "assistant") {
			for (const notification of assistantPartNotifications(context, index, content as readonly PiMessagePart[] | undefined)) {
				await notify(notification);
			}
		} else if (message.role === "toolResult") {
			const notification = toolResultNotification(context, message);
			if (notification) await notify(notification);
		}
	}
}

/**
 * Build the Desktop history payload without embedding tool inputs/results.
 * Tool rows stay fully identifiable and keep their final status, while their
 * heavy payload is retained separately for lazy retrieval when expanded.
 */
export async function deferredSessionHistory(
	pi: PiClient,
	context: TranslateContext,
): Promise<DeferredSessionHistory> {
	return deferredSessionHistoryFromMessages(await pi.getMessages(), context);
}

export function deferredSessionHistoryFromMessages(
	messages: readonly PiAgentMessage[],
	context: TranslateContext,
): DeferredSessionHistory {
	const updates: SessionUpdate[] = [];
	const toolInputs = new Map<string, unknown>();
	const toolResults = new Map<string, DeferredToolResult>();

	for (const [index, message] of messages.entries()) {
		const messageId = `replay-${index}`;
		const content = (message as { content?: unknown }).content;
		if (message.role === "user") {
			if (typeof content === "string") {
				if (content) updates.push(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: content }).update);
			} else if (Array.isArray(content)) {
				for (const part of content as readonly PiMessagePart[]) {
					if (part.type === "text" && typeof part.text === "string" && part.text) {
						updates.push(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: part.text }).update);
					} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
						updates.push(chunk(context.sessionId, messageId, "user_message_chunk", {
							type: "image",
							data: part.data,
							mimeType: part.mimeType,
						}).update);
					}
				}
			}
		} else if (message.role === "assistant") {
			for (const notification of assistantPartNotifications(context, index, content as readonly PiMessagePart[] | undefined, false)) {
				const update = notification.update;
				updates.push(update);
				if (update.sessionUpdate === "tool_call" && update.toolCallId) {
					const toolCallId = update.toolCallId;
					const part = (content as readonly PiMessagePart[] | undefined)?.find(
						(candidate) => candidate.type === "toolCall" && candidate.id === toolCallId,
					);
					if (part?.type === "toolCall" && part.arguments !== undefined) {
						toolInputs.set(toolCallId, part.arguments);
					}
				}
			}
		} else if (message.role === "toolResult") {
			const record = message as { toolCallId?: unknown; isError?: unknown };
			if (typeof record.toolCallId !== "string") continue;
			const toolCallId = record.toolCallId;
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: record.isError === true ? "failed" : "completed",
			});
			toolResults.set(toolCallId, {
				message,
				...(toolInputs.has(toolCallId) ? { rawInput: toolInputs.get(toolCallId) } : {}),
			});
		}
	}

	return { updates, toolResults };
}

/** Materialize the heavy ACP tool payload only when Desktop expands it. */
export function deferredToolResultUpdate(
	context: TranslateContext,
	result: DeferredToolResult,
): SessionUpdate | undefined {
	const notification = toolResultNotification(context, result.message);
	if (!notification || notification.update.sessionUpdate !== "tool_call_update") return undefined;
	return {
		...notification.update,
		...(result.rawInput !== undefined ? { rawInput: result.rawInput } : {}),
	};
}

/**
 * Assistant history in part order: runs of text parts become one
 * `agent_message_chunk`, tool-call parts become `tool_call` notifications.
 */
function assistantPartNotifications(
	context: TranslateContext,
	index: number,
	content: readonly PiMessagePart[] | undefined,
	includeRawInput = true,
): SessionNotification[] {
	const notifications: SessionNotification[] = [];
	if (!content) return notifications;
	let text: string[] = [];
	const flushText = () => {
		const joined = text.join("\n\n").trim();
		text = [];
		if (joined) {
			notifications.push(chunk(context.sessionId, `replay-${index}`, "agent_message_chunk", { type: "text", text: joined }));
		}
	};
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
		} else if (part.type === "toolCall" && typeof part.id === "string") {
			flushText();
			notifications.push(toolCallNotification(context, part, includeRawInput));
		}
	}
	flushText();
	return notifications;
}

function toolCallNotification(context: TranslateContext, part: PiMessagePart, includeRawInput = true): SessionNotification {
	const originalName = typeof part.name === "string" ? part.name : "";
	const name = originalName.toLowerCase();
	const args = (part.arguments ?? undefined) as Record<string, unknown> | undefined;
	const update = {
		sessionUpdate: "tool_call",
		toolCallId: part.id,
		...(originalName ? { name: originalName } : {}),
		title: toolTitle(name || "tool", args),
		kind: toolKind(name || "tool") as ToolKind,
		status: "in_progress",
		...(includeRawInput ? { rawInput: args } : {}),
		locations: toolLocations(context, name, args),
	} as SessionUpdate;
	return { sessionId: context.sessionId, update };
}

/** One `toolResult` history message becomes a completed `tool_call_update`. */
function toolResultNotification(context: TranslateContext, message: PiAgentMessage): SessionNotification | undefined {
	const record = message as {
		toolCallId?: unknown;
		content?: unknown;
		details?: unknown;
		isError?: unknown;
	};
	if (typeof record.toolCallId !== "string") return undefined;
	const parts = (record.content as readonly PiMessagePart[] | undefined) ?? [];
	const content: ToolCallContent[] = [];
	for (const part of parts) {
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "content", content: { type: "text", text: part.text } });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			content.push({ type: "content", content: { type: "image", data: part.data, mimeType: part.mimeType } });
		}
	}
	const update: Record<string, unknown> = {
		sessionUpdate: "tool_call_update",
		toolCallId: record.toolCallId,
		status: record.isError === true ? "failed" : "completed",
	};
	if (content.length > 0) update.content = content;
	if (record.details !== undefined) update.rawOutput = record.details;
	return { sessionId: context.sessionId, update: update as SessionUpdate };
}

function chunk(
	sessionId: string,
	messageId: string,
	sessionUpdate: "user_message_chunk" | "agent_message_chunk",
	content: import("@agentclientprotocol/sdk").ContentBlock,
): SessionNotification {
	const update: SessionUpdate = {
		sessionUpdate,
		messageId,
		content,
	};
	return { sessionId, update };
}

/** Exposed for tests. */
export type { PiAgentMessage };
