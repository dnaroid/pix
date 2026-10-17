import { RPC_SESSION_STATE_WIDGET_KEY } from "../../lib/rpc-session-state.js";
import type { AgentState, RpcEventRecord } from "./types.js";
import { isRecord } from "./utils.js";

/** Consume the child-local plan, never the parent event bus or project plan. */
export function todoProgressFromRpcEvent(event: RpcEventRecord): AgentState["todoProgress"] {
	if (event.type !== "extension_ui_request" || event.method !== "setWidget"
		|| event.widgetKey !== RPC_SESSION_STATE_WIDGET_KEY || !Array.isArray(event.widgetLines)
		|| event.widgetLines.length !== 2 || event.widgetLines[0] !== "pi-tools-suite:todo:state"
		|| typeof event.widgetLines[1] !== "string") return undefined;
	try {
		const snapshot: unknown = JSON.parse(event.widgetLines[1]);
		if (!isRecord(snapshot) || snapshot.version !== 1 || !isRecord(snapshot.details)
			|| !Array.isArray(snapshot.details.tasks)) return undefined;
		let completed = 0;
		let total = 0;
		for (const task of snapshot.details.tasks) {
			if (!isRecord(task) || !["pending", "in_progress", "deferred", "completed", "deleted"].includes(String(task.status))) return undefined;
			if (task.status === "deleted") continue;
			total++;
			if (task.status === "completed") completed++;
		}
		return { completed, total };
	} catch {
		return undefined;
	}
}
