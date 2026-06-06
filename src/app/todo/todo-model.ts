import { THINKING_LEVELS, TODO_ACTIONS, TODO_STATUSES } from "../constants.js";
import type { StyledSegment, ThinkingLevel, TodoAction, TodoDetails, TodoLiveStateEvent, TodoStatus, TodoTask, TodoTaskLinePart, TodoTaskRow } from "../types.js";
import { isNumberArray, isRecord } from "../guards.js";
import { APP_ICONS } from "../icons.js";

export function isTodoAction(value: unknown): value is TodoAction {
	return typeof value === "string" && TODO_ACTIONS.includes(value as TodoAction);
}

export function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

export function isTodoThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function isTodoTask(value: unknown): value is TodoTask {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "number") return false;
	if (typeof value.subject !== "string") return false;
	if (!isTodoStatus(value.status)) return false;
	if (value.description !== undefined && typeof value.description !== "string") return false;
	if (value.activeForm !== undefined && typeof value.activeForm !== "string") return false;
	if (value.thinking !== undefined && !isTodoThinkingLevel(value.thinking)) return false;
	if (value.parentId !== undefined && typeof value.parentId !== "number") return false;
	if (value.blockedBy !== undefined && !isNumberArray(value.blockedBy)) return false;
	if (value.owner !== undefined && typeof value.owner !== "string") return false;
	if (value.metadata !== undefined && !isRecord(value.metadata)) return false;
	return true;
}

export function isTodoDetails(value: unknown): value is TodoDetails {
	if (!isRecord(value)) return false;
	if (!isTodoAction(value.action)) return false;
	if (!isRecord(value.params)) return false;
	if (!Array.isArray(value.tasks)) return false;
	if (typeof value.nextId !== "number") return false;
	if (value.error !== undefined && typeof value.error !== "string") return false;
	return value.tasks.every(isTodoTask);
}

export function isTodoLiveStateEvent(value: unknown): value is TodoLiveStateEvent {
	if (!isRecord(value)) return false;
	if (value.version !== 1) return false;
	if (!isTodoDetails(value.details)) return false;
	if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") return false;
	return typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt);
}

export function todoStatusIcon(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return APP_ICONS.circleOutline;
		case "in_progress":
			return APP_ICONS.timerSand;
		case "deferred":
			return APP_ICONS.deferred;
		case "completed":
			return APP_ICONS.checkCircle;
		case "deleted":
			return APP_ICONS.deleted;
	}
}

export function visibleTodoTasks(details: TodoDetails, showDeleted = false): TodoTask[] {
	return showDeleted ? details.tasks : details.tasks.filter((task) => task.status !== "deleted");
}

export function hasOpenTodoTasks(details: TodoDetails): boolean {
	return visibleTodoTasks(details).some((task) => task.status !== "completed");
}

export function visibleTodoTaskRows(details: TodoDetails, showDeleted = false): TodoTaskRow[] {
	const tasks = visibleTodoTasks(details, showDeleted);
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const childrenByParentId = new Map<number, TodoTask[]>();
	const roots: TodoTask[] = [];

	for (const task of tasks) {
		if (task.parentId !== undefined && task.parentId !== task.id && tasksById.has(task.parentId)) {
			const children = childrenByParentId.get(task.parentId) ?? [];
			children.push(task);
			childrenByParentId.set(task.parentId, children);
		} else {
			roots.push(task);
		}
	}

	const rows: TodoTaskRow[] = [];
	const emitted = new Set<number>();
	const emitTask = (task: TodoTask, depth: number): void => {
		if (emitted.has(task.id)) return;
		emitted.add(task.id);
		rows.push({ task, depth });
		for (const child of childrenByParentId.get(task.id) ?? []) emitTask(child, depth + 1);
	};

	for (const task of roots) emitTask(task, 0);
	for (const task of tasks) emitTask(task, 0);

	return rows;
}

export function todoTaskLineParts(task: TodoTask, options: { depth?: number } = {}): TodoTaskLinePart[] {
	const treePrefix = todoTaskTreePrefix(options.depth ?? 0);
	const subjectPart: TodoTaskLinePart = { text: `${task.id}.${task.subject}` };
	if (task.thinking) subjectPart.thinking = task.thinking;
	const parts: TodoTaskLinePart[] = [
		{ text: `${treePrefix}${todoStatusIcon(task.status)}` },
		subjectPart,
	];
	if (task.status === "in_progress" && task.activeForm) parts.push({ text: `— ${task.activeForm}` });
	if (task.parentId !== undefined) parts.push({ text: `parent:#${task.parentId}` });
	if (task.blockedBy && task.blockedBy.length > 0) parts.push({ text: `blocked:${task.blockedBy.map((id) => `#${id}`).join(",")}` });
	return parts;
}

export function formatTodoTaskLine(task: TodoTask, options: { depth?: number } = {}): string {
	return todoTaskLineParts(task, options).map((part) => part.text).join(" ");
}

export function todoTaskLineSegments(task: TodoTask, mutedColor: string, options: { depth?: number; thinkingColor?: (level: ThinkingLevel) => string; statusColor?: (status: TodoStatus) => string } = {}): StyledSegment[] {
	const segments: StyledSegment[] = [];
	let offset = 0;
	for (const [index, part] of todoTaskLineParts(task, options).entries()) {
		if (index > 0) offset += 1;
		const start = offset;
		const end = start + part.text.length;
		const segment: StyledSegment = { start, end };
		if (index === 0 && options.statusColor) {
			const foreground = options.statusColor(task.status);
			if (foreground) segment.foreground = foreground;
		}
		else if (part.thinking) {
			const foreground = options.thinkingColor?.(part.thinking);
			if (foreground) segment.foreground = foreground;
		}
		else if (part.muted) segment.foreground = mutedColor;
		if (task.status === "completed" && index > 0) segment.strikethrough = true;
		if ((segment.foreground || segment.strikethrough) && end > start) segments.push(segment);
		offset = end;
	}
	return segments;
}

function todoTaskTreePrefix(depth: number): string {
	if (depth <= 0) return "";
	return `${"  ".repeat(depth)}↳ `;
}

export function shiftSegmentsToSlice(segments: readonly StyledSegment[], start: number, length: number): StyledSegment[] {
	const end = start + length;
	return segments
		.map((segment) => ({
			...segment,
			start: Math.max(segment.start, start) - start,
			end: Math.min(segment.end, end) - start,
		}))
		.filter((segment) => segment.end > segment.start);
}

export function formatTodoPanelStats(tasks: readonly TodoTask[]): string {
	const stats = [
		{ count: tasks.filter((task) => task.status === "in_progress").length, label: "active" },
		{ count: tasks.filter((task) => task.status === "pending").length, label: "pending" },
		{ count: tasks.filter((task) => task.status === "completed").length, label: "done" },
		{ count: tasks.filter((task) => task.status === "deferred").length, label: "deferred" },
	]
		.filter(({ count }) => count > 0)
		.map(({ count, label }) => `${count} ${label}`);

	return stats.join(", ");
}
