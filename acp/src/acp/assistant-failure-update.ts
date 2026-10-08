import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** A system transcript row for a failed provider turn, not a model-authored reply. */
export const ASSISTANT_FAILURE_MESSAGE_PREFIX = "pix-system:error:";

/**
 * ACP 1.4 has no provider-error session update. Preserve Pi's actual failure
 * message in a clearly identified system row instead of losing it at `message_end`.
 * Both live events and persisted history use this conversion.
 */
export function assistantFailureUpdate(message: unknown, fallbackId = "unknown"): SessionUpdate | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || record.stopReason !== "error") return undefined;
	const detail = typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
	const timestamp = record.timestamp;
	const id = typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
		? String(timestamp)
		: fallbackId;
	return {
		sessionUpdate: "agent_message_chunk",
		messageId: `${ASSISTANT_FAILURE_MESSAGE_PREFIX}${id}`,
		content: { type: "text", text: (detail || "The provider stopped without reporting a reason.").slice(0, 2_048) },
	};
}
