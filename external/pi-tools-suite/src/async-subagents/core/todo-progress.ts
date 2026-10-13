import * as fs from "node:fs";
import * as path from "node:path";
import { RPC_SESSION_STATE_WIDGET_KEY } from "../../lib/rpc-session-state.js";
import type { AgentState, RpcEventRecord } from "./types.js";
import { isRecord } from "./utils.js";

export const TODO_PROGRESS_FILE = "todo-progress.json";

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

/** Tiny atomic snapshot survives bounded/truncated diagnostic logs. */
export function writeTodoProgress(agentDir: string, progress: NonNullable<AgentState["todoProgress"]>): void {
	const file = path.join(agentDir, TODO_PROGRESS_FILE);
	try {
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(progress), "utf8");
		fs.renameSync(`${file}.tmp`, file);
	} catch {
		// Optional telemetry must not fail the child or resurrect a cleaned run.
	}
}

export function readTodoProgress(agentDir: string): AgentState["todoProgress"] {
	try {
		const file = path.join(agentDir, TODO_PROGRESS_FILE);
		if (fs.statSync(file).size > 256) return undefined;
		const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(value) || !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total)
			|| (value.completed as number) < 0 || (value.total as number) < (value.completed as number)) return undefined;
		return { completed: value.completed as number, total: value.total as number };
	} catch {
		return undefined;
	}
}
