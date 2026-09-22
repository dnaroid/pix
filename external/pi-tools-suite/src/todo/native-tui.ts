import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { isNativePiTui } from "../lib/native-pi-tui.js";
import { setNativePiAboveWidget } from "../lib/native-pi-widget-order.js";
import { ACTIVE_STATUSES, isTaskBlocked } from "./state/selectors.js";
import type { TaskState } from "./state/state.js";
import type { Task, TaskStatus } from "./tool/types.js";

export const TODO_NATIVE_WIDGET_KEY = "pi-tools-suite:todo";
const MAX_VISIBLE_TASKS = 5;

interface TodoWidgetRow {
	readonly id: number;
	readonly status: TaskStatus;
	readonly subject: string;
	readonly activeForm: string | undefined;
	readonly blocked: boolean;
	readonly blockers: string | undefined;
}

interface TodoWidgetModel {
	readonly counts: string;
	readonly rows: readonly TodoWidgetRow[];
	readonly overflow: number;
}

export function updateTodoNativeWidget(ctx: ExtensionContext, state: TaskState): void {
	if (!isNativePiTui(ctx)) return;
	const model = prepareTodoWidgetModel(state);
	if (model === undefined) {
		setNativePiAboveWidget(ctx, TODO_NATIVE_WIDGET_KEY, undefined);
		return;
	}

	setNativePiAboveWidget(ctx, TODO_NATIVE_WIDGET_KEY, (_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const lines = [
				truncateToWidth(theme.fg("accent", theme.bold("Tasks")) + " " + theme.fg("dim", model.counts), width),
			];

			for (const task of model.rows) {
				const glyph = task.blocked
					? theme.fg("warning", "⊘")
					: task.status === "in_progress"
						? theme.fg("success", "●")
						: theme.fg("dim", "○");
				const label = task.status === "in_progress" && task.activeForm
					? task.subject + " — " + task.activeForm
					: task.subject;
				const blockers = task.blocked && task.blockers
					? theme.fg("dim", " ← #" + task.blockers)
					: "";
				lines.push(truncateToWidth("  " + glyph + " " + theme.fg("accent", "#" + task.id) + " " + label + blockers, width));
			}
			if (model.overflow > 0) {
				lines.push(truncateToWidth(theme.fg("dim", "  … " + model.overflow + " more"), width));
			}
			return lines;
		},
	}));
}

function prepareTodoWidgetModel(state: TaskState): TodoWidgetModel | undefined {
	const byId = new Map<number, Task>();
	for (const task of state.tasks) {
		if (task.status !== "deleted") byId.set(task.id, task);
	}
	let active = 0;
	let inProgress = 0;
	let blocked = 0;
	const rows: TodoWidgetRow[] = [];
	for (const task of state.tasks) {
		if (task.status === "deleted" || !ACTIVE_STATUSES.has(task.status)) continue;
		active++;
		if (task.status === "in_progress") inProgress++;
		const taskBlocked = isTaskBlocked(task, byId);
		if (taskBlocked) blocked++;
		if (rows.length < MAX_VISIBLE_TASKS) {
			rows.push(Object.freeze({
				id: task.id,
				status: task.status,
				subject: task.subject,
				activeForm: task.activeForm,
				blocked: taskBlocked,
				blockers: taskBlocked && task.blockedBy?.length ? task.blockedBy.join(", #") : undefined,
			}));
		}
	}
	if (active === 0) return undefined;
	const pending = active - inProgress;
	const counts = [
		inProgress > 0 ? String(inProgress) + " active" : undefined,
		pending > 0 ? String(pending) + " pending" : undefined,
		blocked > 0 ? String(blocked) + " blocked" : undefined,
	].filter((value): value is string => value !== undefined).join(" · ");
	return Object.freeze({ counts, rows: Object.freeze(rows), overflow: active - rows.length });
}

export function clearTodoNativeWidget(ctx: ExtensionContext): void {
	if (!isNativePiTui(ctx)) return;
	setNativePiAboveWidget(ctx, TODO_NATIVE_WIDGET_KEY, undefined);
}
