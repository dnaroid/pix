import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.js";

/**
 * Format a single task for the LLM-facing `list` response. The `/todos`
 * command uses `view/format.ts` for its grouped text presentation.
 */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const parent = t.parentId !== undefined ? ` ↳ #${t.parentId}` : "";
	const priority = t.priority ? ` (${t.priority})` : "";
	const tags = t.tags?.length ? ` ${t.tags.map((tag) => `#${tag}`).join(" ")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	return `[${t.status}] #${t.id} ${t.subject}${priority}${form}${parent}${block}${tags}`;
}

/**
 * Multi-line presentation for the `get` action. Keep the most actionable task
 * fields near the top, then dependency and ownership metadata.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.priority) lines.push(`  priority: ${task.priority}`);
	if (task.parentId !== undefined) lines.push(`  parentId: #${task.parentId}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.tags?.length) lines.push(`  tags: ${task.tags.map((tag) => `#${tag}`).join(" ")}`);
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

function filterTasks(op: Extract<Op, { kind: "list" | "export" }>, state: TaskState): Task[] {
	let view = state.tasks;
	if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
	if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
	if (op.priorityFilter) view = view.filter((t) => t.priority === op.priorityFilter);
	const tagFilter = op.tagFilter;
	if (tagFilter) view = view.filter((t) => t.tags?.includes(tagFilter));
	if (op.blockedOnly) view = view.filter((t) => (t.blockedBy?.length ?? 0) > 0);
	return view;
}

function formatMarkdownExport(tasks: readonly Task[]): string {
	const byParent = new Map<number | undefined, Task[]>();
	for (const task of tasks) {
		const siblings = byParent.get(task.parentId) ?? [];
		siblings.push(task);
		byParent.set(task.parentId, siblings);
	}
	const lines: string[] = [];
	const seen = new Set<number>();
	const visit = (task: Task, depth: number) => {
		if (seen.has(task.id)) return;
		seen.add(task.id);
		const checked = task.status === "completed" ? "x" : " ";
		const priority = task.priority ? ` (${task.priority})` : "";
		const status = task.status === "deferred" ? " {deferred}" : "";
		const tags = task.tags?.length ? ` [${task.tags.map((tag) => `#${tag}`).join(" ")}]` : "";
		const blocked = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
		lines.push(`${"  ".repeat(depth)}- [${checked}] #${task.id}${priority} ${task.subject}${status}${blocked}${tags}`);
		for (const child of byParent.get(task.id) ?? []) visit(child, depth + 1);
	};
	for (const root of byParent.get(undefined) ?? []) visit(root, 0);
	for (const task of tasks) visit(task, 0);
	return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			// Defensive — `op.taskId` always resolves on success path.
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${t.subject} (pending)`;
		}
		case "update": {
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "batch_create":
			return `Created ${op.ids.length} tasks: ${op.ids.map((id) => `#${id}`).join(", ")}`;
		case "batch_update":
			return `Updated ${op.ids.length} tasks: ${op.ids.map((id) => `#${id}`).join(", ")}`;
		case "delete":
			return `Deleted #${op.id}: ${op.subject}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			const view = filterTasks(op, state);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "export": {
			const tasks = filterTasks(op, state);
			if (op.format === "markdown") return formatMarkdownExport(tasks);
			return JSON.stringify({ tasks, nextId: state.nextId }, null, 2);
		}
		case "import":
			return `Imported ${op.count} tasks${op.replaced ? " (replaced existing tasks)" : ""}`;
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
