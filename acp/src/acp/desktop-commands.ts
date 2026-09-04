import { RequestError } from "@agentclientprotocol/sdk";

const ERROR_INVALID_PARAMS = -32602;

export const PIX_FORK_MESSAGES_METHOD = "pix/session/fork_messages";
export const PIX_RELOAD_SESSION_METHOD = "pix/session/reload";

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

export function parseDesktopSessionRequest(value: unknown): DesktopSessionRequest {
	if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string sessionId field");
	}
	return { sessionId: value.sessionId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
