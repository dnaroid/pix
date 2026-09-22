import type { Usage } from "@earendil-works/pi-ai";
import type { RpcEventRecord } from "./types.js";

export interface SubagentUsageEvent {
	provider: string;
	model: string;
	usage: Usage;
}

/** Extract one finalized billable assistant call from a child Pi RPC stream. */
export function subagentUsageFromRpcEvent(event: RpcEventRecord): SubagentUsageEvent | undefined {
	if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return undefined;
	const provider = stringValue(event.message.provider);
	const model = stringValue(event.message.model);
	const usage = parseUsage(event.message.usage);
	if (!provider || !model || !usage) return undefined;
	return { provider, model, usage };
}

type UsageWritableSessionManager = {
	appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown;
};

/**
 * Persist child-agent billing on the parent manager captured by the originating
 * tool call. The public extension context exposes a read-only manager type, but
 * the runtime manager owns appendUsage; capability-check it so usage cannot drift
 * to a different active tab/session while a background agent is still running.
 */
export function recordSubagentUsage(
	manager: object,
	event: RpcEventRecord,
	agentId: string,
): boolean {
	const billable = subagentUsageFromRpcEvent(event);
	if (!billable) return false;
	const writable = manager as UsageWritableSessionManager;
	if (typeof writable.appendUsage !== "function") return false;
	writable.appendUsage("async-subagent", billable.provider, billable.model, billable.usage, `agent:${agentId}`);
	return true;
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	const input = numberValue(value.input);
	const output = numberValue(value.output);
	const cacheRead = numberValue(value.cacheRead);
	const cacheWrite = numberValue(value.cacheWrite);
	const totalTokens = numberValue(value.totalTokens);
	const costInput = numberValue(value.cost.input);
	const costOutput = numberValue(value.cost.output);
	const costCacheRead = numberValue(value.cost.cacheRead);
	const costCacheWrite = numberValue(value.cost.cacheWrite);
	const costTotal = numberValue(value.cost.total);
	if ([input, output, cacheRead, cacheWrite, totalTokens, costInput, costOutput, costCacheRead, costCacheWrite, costTotal].some((item) => item === undefined)) return undefined;
	const reasoning = value.reasoning === undefined ? undefined : numberValue(value.reasoning);
	const cacheWrite1h = value.cacheWrite1h === undefined ? undefined : numberValue(value.cacheWrite1h);
	if (value.reasoning !== undefined && reasoning === undefined) return undefined;
	if (value.cacheWrite1h !== undefined && cacheWrite1h === undefined) return undefined;
	return {
		input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, totalTokens: totalTokens!,
		...(reasoning !== undefined ? { reasoning } : {}),
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		cost: { input: costInput!, output: costOutput!, cacheRead: costCacheRead!, cacheWrite: costCacheWrite!, total: costTotal! },
	};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
