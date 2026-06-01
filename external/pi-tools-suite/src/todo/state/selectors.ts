import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * Group visible tasks by status. Iteration order at the call site uses
 * (`completed`, `inProgress`, `pending`) to match the `/todos` header part
 * order pinned by `todo.command.test.ts`.
 */
export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	deferred: readonly Task[];
	completed: readonly Task[];
}
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		deferred: visible.filter((t) => t.status === "deferred"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

/** Total counts for the `/todos` header. */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	deferred: number;
	completed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.deferred.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		deferred: groups.deferred.length,
		completed: groups.completed.length,
	};
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
