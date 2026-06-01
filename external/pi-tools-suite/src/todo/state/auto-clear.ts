import { EMPTY_STATE, type TaskState } from "./state.js";

export const AUTO_CLEAR_COMPLETED_MESSAGE = "All todos completed; cleared automatically.";

export function shouldAutoClearCompletedTodos(state: TaskState): boolean {
	const visible = state.tasks.filter((task) => task.status !== "deleted");
	return visible.length > 0 && visible.every((task) => task.status === "completed");
}

export function autoClearCompletedTodos(state: TaskState): { state: TaskState; cleared: boolean; count: number } {
	if (!shouldAutoClearCompletedTodos(state)) return { state, cleared: false, count: 0 };
	return { state: { ...EMPTY_STATE, tasks: [] }, cleared: true, count: state.tasks.length };
}
