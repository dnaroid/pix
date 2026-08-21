import type { TaskDetails } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

export const TODO_STATE_ENTRY_TYPE = "pi-tools-suite:todo-state";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

function taskDetailsFromEntry(entry: unknown): TaskDetails | undefined {
	const candidate = entry as {
		type?: string;
		customType?: string;
		data?: unknown;
		message?: { role?: string; toolName?: string; details?: unknown };
	};

	if (candidate.type === "custom" && candidate.customType === TODO_STATE_ENTRY_TYPE) {
		return isTaskDetails(candidate.data) ? candidate.data : undefined;
	}

	const message = candidate.message;
	if (candidate.type !== "message" || message?.role !== "toolResult" || message.toolName !== "todo") return undefined;
	return isTaskDetails(message.details) ? message.details : undefined;
}

/**
 * Walk the current branch in chronological order; the LAST valid snapshot
 * from either a `todo` tool result or a todo custom state entry wins
 * (last-write-wins). Custom entries persist slash-command mutations, which do
 * not otherwise produce tool results. When no matching entry exists, returns
 * `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const details = taskDetailsFromEntry(entry);
		if (!details) continue;
		result = {
			tasks: details.tasks.map((t) => ({ ...t })),
			nextId: details.nextId,
		};
	}
	return result;
}
