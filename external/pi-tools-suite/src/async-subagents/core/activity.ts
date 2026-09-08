import type { AgentActivity, RpcEventRecord } from "./types.js";
import { isRecord, isoNow } from "./utils.js";

export function activityFromRpcEvent(event: RpcEventRecord, at = isoNow()): AgentActivity | undefined {
	if (event.type === "tool_execution_start") {
		const toolName = nonEmptyString(event.toolName);
		return toolName ? { label: toolName, at } : undefined;
	}
	if ((event.type === "message_start" || event.type === "message_end") && rpcMessageRole(event) === "assistant") {
		return { label: "Thinking", at };
	}
	return undefined;
}

export function activityFromProgressRecord(value: unknown): AgentActivity | undefined {
	if (!isRecord(value) || value.stage !== "rpc_event") return undefined;
	const at = nonEmptyString(value.at);
	if (!at) return undefined;
	const toolName = nonEmptyString(value.toolName);
	if (toolName) return { label: toolName, at };
	if (value.type === "message_start" || value.type === "message_end") return { label: "Thinking", at };
	return undefined;
}

function rpcMessageRole(event: RpcEventRecord): string | undefined {
	const directRole = nonEmptyString(event.role);
	if (directRole) return directRole;
	return isRecord(event.message) ? nonEmptyString(event.message.role) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
