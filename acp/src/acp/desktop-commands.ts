import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";

const ERROR_INVALID_PARAMS = -32602;

export const PIX_FORK_MESSAGES_METHOD = "pix/session/fork_messages";
export const PIX_RELOAD_SESSION_METHOD = "pix/session/reload";
export const PIX_SESSION_HISTORY_METHOD = "pix/session/history";
export const PIX_TOOL_RESULT_METHOD = "pix/session/tool_result";
export const PIX_SESSION_IMAGE_METHOD = "pix/session/image";

export interface DesktopSessionRequest {
	readonly sessionId: string;
}

export interface ForkMessage {
	readonly entryId: string;
	readonly text: string;
}

export interface ForkMessagesResponse {
	readonly messages: readonly ForkMessage[];
}

export interface DesktopSessionHistoryResponse {
	readonly updates: readonly SessionUpdate[];
	readonly deferredToolCallIds: readonly string[];
}

export interface DesktopToolResultRequest extends DesktopSessionRequest {
	readonly toolCallId: string;
}

export interface DesktopToolResultResponse {
	readonly update: SessionUpdate;
}

export interface DesktopSessionImageRequest extends DesktopSessionRequest {
	readonly imageId: string;
}

export interface DesktopSessionImageResponse {
	readonly data: string;
	readonly mimeType: string;
}

export function parseDesktopSessionRequest(value: unknown): DesktopSessionRequest {
	if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string sessionId field");
	}
	return { sessionId: value.sessionId };
}

export function parseDesktopToolResultRequest(value: unknown): DesktopToolResultRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.toolCallId !== "string" || value.toolCallId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string toolCallId field");
	}
	return { ...session, toolCallId: value.toolCallId };
}

export function parseDesktopSessionImageRequest(value: unknown): DesktopSessionImageRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.imageId !== "string" || value.imageId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string imageId field");
	}
	return { ...session, imageId: value.imageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
