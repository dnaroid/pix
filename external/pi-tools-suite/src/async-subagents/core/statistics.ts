import type { AgentTaskPreview } from "../types.js";
import type { RpcEventRecord } from "./types.js";

const CUSTOM_TYPE = "pi-tools-suite:subagent-statistics";
type StatisticsManager = { appendCustomEntry?: (type: string, data: unknown) => unknown };

/** Keep task/tool telemetry on the same captured parent manager as billing. */
function append(manager: unknown, data: Record<string, unknown>): boolean {
	try {
		if (typeof manager !== "object" || manager === null) return false;
		const writable = manager as StatisticsManager;
		if (typeof writable.appendCustomEntry !== "function") return false;
		writable.appendCustomEntry(CUSTOM_TYPE, { ...data, version: 1 });
		return true;
	} catch {
		// Optional diagnostics must never prevent scheduling or child event delivery.
		return false;
	}
}

export function recordSubagentTaskStatistics(manager: unknown, runDir: string, task: AgentTaskPreview): boolean {
	return append(manager, { ...task, event: "task", runDir });
}

export function recordSubagentStateStatistics(manager: unknown, runDir: string, id: string, status: string): boolean {
	return append(manager, { event: "state", runDir, id, status });
}

export function recordSubagentToolStatistics(manager: unknown, event: RpcEventRecord, runDir: string, id: string): boolean {
	if (event.type !== "tool_execution_start" || typeof event.toolName !== "string" || !event.toolName.trim()) return false;
	return append(manager, { event: "tool", runDir, id, toolName: event.toolName.trim() });
}
