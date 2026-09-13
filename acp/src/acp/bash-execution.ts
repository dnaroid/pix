import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { PiAgentMessage, PiBashResult } from "../pi/pi-rpc-client.js";
import { toolTitle } from "./event-translator.js";

const PIX_ACTIVITY_TIMING_META_KEY = "pix.activityTiming";

export function bashExecutionStartUpdate(
	toolCallId: string,
	command: string,
	excludeFromContext: boolean,
	startedAtMs?: number,
): SessionUpdate {
	const title = toolTitle("bash", { command });
	return withTiming({
		sessionUpdate: "tool_call",
		toolCallId,
		name: "bash",
		title: excludeFromContext ? title.replace(/^Bash:/u, "Bash (no context):") : title,
		kind: "execute",
		status: "in_progress",
		rawInput: { command, excludeFromContext },
	} as SessionUpdate, startedAtMs === undefined ? undefined : { startedAtMs });
}

export function bashExecutionResultUpdate(
	toolCallId: string,
	result: PiBashResult,
	endedAtMs?: number,
): SessionUpdate {
	const contentText = bashResultText(result);
	const content: ToolCallContent[] = contentText
		? [{ type: "content", content: { type: "text", text: contentText } }]
		: [];
	return withTiming({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: result.cancelled || (result.exitCode !== undefined && result.exitCode !== 0) ? "failed" : "completed",
		...(content.length > 0 ? { content } : {}),
		rawOutput: result,
	} as SessionUpdate, endedAtMs === undefined ? undefined : { endedAtMs });
}

export function bashExecutionErrorUpdate(toolCallId: string, error: unknown, endedAtMs?: number): SessionUpdate {
	const message = error instanceof Error ? error.message : String(error);
	return withTiming({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "failed",
		content: [{ type: "content", content: { type: "text", text: message } }],
		rawOutput: { error: message },
	} as SessionUpdate, endedAtMs === undefined ? undefined : { endedAtMs });
}

/** Translate pi's persisted `bashExecution` message into Desktop tool rows. */
export function replayBashExecutionUpdates(message: PiAgentMessage, replayId: number | string): SessionUpdate[] | undefined {
	if (message.role !== "bashExecution") return undefined;
	const record = message as PiAgentMessage & {
		readonly command?: unknown;
		readonly output?: unknown;
		readonly exitCode?: unknown;
		readonly cancelled?: unknown;
		readonly truncated?: unknown;
		readonly fullOutputPath?: unknown;
		readonly excludeFromContext?: unknown;
	};
	if (
		typeof record.command !== "string"
		|| typeof record.output !== "string"
		|| (record.exitCode !== undefined && typeof record.exitCode !== "number")
		|| typeof record.cancelled !== "boolean"
		|| typeof record.truncated !== "boolean"
	) return undefined;

	const result: PiBashResult = {
		output: record.output,
		exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
		cancelled: record.cancelled,
		truncated: record.truncated,
		...(typeof record.fullOutputPath === "string" ? { fullOutputPath: record.fullOutputPath } : {}),
	};
	const toolCallId = `${typeof replayId === "number" ? `replay-${replayId}` : replayId}:bash`;
	const endedAtMs = finiteTimestamp(message.persistedAtMs) ?? finiteTimestamp(message.timestamp);
	return [
		bashExecutionStartUpdate(toolCallId, record.command, record.excludeFromContext === true),
		bashExecutionResultUpdate(toolCallId, result, endedAtMs),
	];
}

function bashResultText(result: PiBashResult): string {
	const parts: string[] = [];
	if (result.output) parts.push(result.output.replace(/\s+$/u, ""));
	if (result.cancelled) parts.push("(cancelled)");
	else if (result.exitCode !== undefined && result.exitCode !== 0) parts.push(`(exit ${result.exitCode})`);
	if (result.truncated && result.fullOutputPath) {
		parts.push(`Output truncated. Full output: ${result.fullOutputPath}`);
	}
	return parts.filter(Boolean).join("\n");
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withTiming(
	update: SessionUpdate,
	timing: { readonly startedAtMs?: number; readonly endedAtMs?: number } | undefined,
): SessionUpdate {
	if (!timing) return update;
	return {
		...update,
		_meta: {
			...(update._meta ?? {}),
			[PIX_ACTIVITY_TIMING_META_KEY]: timing,
		},
	} as SessionUpdate;
}
