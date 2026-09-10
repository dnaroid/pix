/**
 * Replays persisted pi session history as ACP `session/update` notifications
 * for `session/load`.
 *
 * ACP 1.4 has no dedicated history message: loaded conversations are
 * re-emitted as `user_message_chunk` / `agent_message_chunk` /
 * `agent_thought_chunk` updates plus `tool_call` / `tool_call_update` pairs for
 * tool usage. Stable replay ids preserve part ordering, and tool calls reuse
 * the pi tool-call ids so clients correlate call and result.
 */

import type { SessionNotification, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { toolKind, toolLocations, toolTitle, type TranslateContext } from "./event-translator.js";
import type { PiAgentMessage, PiClient, PiMessagePart } from "../pi/pi-rpc-client.js";
import { DEFERRED_PERSISTED_IMAGE_PREFIX } from "./session-history-file.js";

export const DEFERRED_IMAGE_URI_PREFIX = "pix-deferred-image:";
const PIX_ACTIVITY_TIMING_META_KEY = "pix.activityTiming";

interface ActivityTimingMeta {
	readonly startedAtMs?: number;
	readonly endedAtMs?: number;
}

export interface DeferredSessionHistory {
	readonly updates: readonly SessionUpdate[];
	readonly toolResults: ReadonlyMap<string, DeferredToolResult>;
	readonly images: ReadonlyMap<string, DeferredImageResult>;
}

export interface DeferredToolResult {
	readonly message: PiAgentMessage;
	readonly rawInput?: unknown;
}

export interface DeferredImageResult {
	readonly mimeType: string;
	readonly data?: string;
	readonly persistedImageId?: string;
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
			for (const notification of assistantPartNotifications(
				context,
				index,
				content as readonly PiMessagePart[] | undefined,
				true,
				assistantPersistedTiming(message),
			)) {
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
	const images = new Map<string, DeferredImageResult>();

	for (const [index, message] of messages.entries()) {
		const messageId = `replay-${index}`;
		const content = (message as { content?: unknown }).content;
		if (message.role === "user") {
			if (typeof content === "string") {
				if (content) updates.push(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: content }).update);
			} else if (Array.isArray(content)) {
				let imageIndex = 0;
				for (const part of content as readonly PiMessagePart[]) {
					if (part.type === "text" && typeof part.text === "string" && part.text) {
						updates.push(chunk(context.sessionId, messageId, "user_message_chunk", { type: "text", text: part.text }).update);
					} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
						const persistedImageId = part.data.startsWith(DEFERRED_PERSISTED_IMAGE_PREFIX) ? part.data : undefined;
						const imageId = persistedImageId ?? `${messageId}:image:${imageIndex}`;
						images.set(imageId, persistedImageId
							? { mimeType: part.mimeType, persistedImageId }
							: { mimeType: part.mimeType, data: part.data });
						updates.push(chunk(context.sessionId, messageId, "user_message_chunk", {
							type: "resource_link",
							uri: `${DEFERRED_IMAGE_URI_PREFIX}${encodeURIComponent(imageId)}`,
							name: imageFileName(part.mimeType, imageIndex),
							mimeType: part.mimeType,
						}).update);
						imageIndex += 1;
					}
				}
			}
		} else if (message.role === "assistant") {
			for (const notification of assistantPartNotifications(
				context,
				index,
				content as readonly PiMessagePart[] | undefined,
				false,
				assistantPersistedTiming(message),
			)) {
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
			updates.push(withActivityTiming({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: record.isError === true ? "failed" : "completed",
			} as SessionUpdate, toolResultPersistedTiming(message)));
			toolResults.set(toolCallId, {
				message,
				...(toolInputs.has(toolCallId) ? { rawInput: toolInputs.get(toolCallId) } : {}),
			});
		}
	}

	return { updates, toolResults, images };
}

function imageFileName(mimeType: string, index: number): string {
	const subtype = mimeType.split("/").at(-1)?.replace("jpeg", "jpg") || "bin";
	return `image-${index + 1}.${subtype}`;
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
 * `agent_message_chunk`, thinking parts become `agent_thought_chunk`, and
 * tool-call parts become `tool_call` notifications.
 */
function assistantPartNotifications(
	context: TranslateContext,
	index: number,
	content: readonly PiMessagePart[] | undefined,
	includeRawInput = true,
	persistedTiming?: ActivityTimingMeta,
): SessionNotification[] {
	const notifications: SessionNotification[] = [];
	if (!content) return notifications;
	const thinkingPartCount = content.filter((part) => part.type === "thinking").length;
	const thinkingTiming = thinkingPartCount === 1
		&& persistedTiming?.startedAtMs !== undefined
		&& persistedTiming.endedAtMs !== undefined
		? persistedTiming
		: undefined;
	const toolTiming = persistedTiming?.endedAtMs === undefined
		? undefined
		: { startedAtMs: persistedTiming.endedAtMs };
	let text: string[] = [];
	let textRun = 0;
	const flushText = () => {
		const joined = text.join("\n\n").trim();
		text = [];
		if (joined) {
			notifications.push(chunk(
				context.sessionId,
				`replay-${index}:text:${textRun++}`,
				"agent_message_chunk",
				{ type: "text", text: joined },
			));
		}
	};
	for (const [partIndex, part] of content.entries()) {
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
		} else if (part.type === "thinking") {
			flushText();
			const thinking = typeof part.thinking === "string" ? part.thinking.trim() : "";
			// Keep the activity row even for opaque/redacted reasoning that has no
			// user-visible body. The Desktop renders the zero-width marker only as
			// the collapsed "thinking" service row.
			notifications.push(chunk(
				context.sessionId,
				`replay-${index}:thinking:${partIndex}`,
				"agent_thought_chunk",
				{ type: "text", text: thinking || "\u200B" },
				thinkingTiming,
			));
		} else if (part.type === "toolCall" && typeof part.id === "string") {
			flushText();
			notifications.push(toolCallNotification(context, part, includeRawInput, toolTiming));
		}
	}
	flushText();
	return notifications;
}

function toolCallNotification(
	context: TranslateContext,
	part: PiMessagePart,
	includeRawInput = true,
	timing?: ActivityTimingMeta,
): SessionNotification {
	const originalName = typeof part.name === "string" ? part.name : "";
	const name = originalName.toLowerCase();
	const args = (part.arguments ?? undefined) as Record<string, unknown> | undefined;
	const update = withActivityTiming({
		sessionUpdate: "tool_call",
		toolCallId: part.id,
		...(originalName ? { name: originalName } : {}),
		title: toolTitle(name || "tool", args),
		kind: toolKind(name || "tool") as ToolKind,
		status: "in_progress",
		...(includeRawInput ? { rawInput: args } : {}),
		locations: toolLocations(context, name, args),
	} as SessionUpdate, timing);
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
	let update = {
		sessionUpdate: "tool_call_update",
		toolCallId: record.toolCallId,
		status: record.isError === true ? "failed" : "completed",
	} as SessionUpdate;
	update = withActivityTiming(update, toolResultPersistedTiming(message));
	const updateRecord = update as unknown as Record<string, unknown>;
	if (content.length > 0) updateRecord.content = content;
	if (record.details !== undefined) updateRecord.rawOutput = record.details;
	return { sessionId: context.sessionId, update };
}

function chunk(
	sessionId: string,
	messageId: string,
	sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
	content: import("@agentclientprotocol/sdk").ContentBlock,
	timing?: ActivityTimingMeta,
): SessionNotification {
	const update = withActivityTiming({
		sessionUpdate,
		messageId,
		content,
	} as SessionUpdate, timing);
	return { sessionId, update };
}

function assistantPersistedTiming(message: PiAgentMessage): ActivityTimingMeta | undefined {
	const startedAtMs = finiteTimestamp(message.timestamp);
	const endedAtMs = finiteTimestamp(message.persistedAtMs);
	if (startedAtMs === undefined || endedAtMs === undefined || endedAtMs < startedAtMs) {
		return endedAtMs === undefined ? undefined : { endedAtMs };
	}
	return { startedAtMs, endedAtMs };
}

function toolResultPersistedTiming(message: PiAgentMessage): ActivityTimingMeta | undefined {
	const endedAtMs = finiteTimestamp(message.persistedAtMs) ?? finiteTimestamp(message.timestamp);
	return endedAtMs === undefined ? undefined : { endedAtMs };
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withActivityTiming(update: SessionUpdate, timing: ActivityTimingMeta | undefined): SessionUpdate {
	if (!timing || (timing.startedAtMs === undefined && timing.endedAtMs === undefined)) return update;
	return {
		...update,
		_meta: {
			...(update._meta ?? {}),
			[PIX_ACTIVITY_TIMING_META_KEY]: timing,
		},
	} as SessionUpdate;
}

/** Exposed for tests. */
export type { PiAgentMessage };
