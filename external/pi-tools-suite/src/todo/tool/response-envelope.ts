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
	const thinking = t.thinking ? ` {thinking:${t.thinking}}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	return `[${t.status}] #${t.id} ${t.subject}${thinking}${form}${parent}${block}`;
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
	if (task.thinking) lines.push(`  thinking: ${task.thinking}`);
	if (task.parentId !== undefined) lines.push(`  parentId: #${task.parentId}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

function filterTasks(op: Extract<Op, { kind: "list" | "export" }>, state: TaskState): Task[] {
	let view = state.tasks;
	if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
	if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
	if (op.blockedOnly) view = view.filter((t) => (t.blockedBy?.length ?? 0) > 0);
	return view;
}

function formatReplacePrefix(replacedCount: number | undefined): string {
	if (!replacedCount) return "";
	return `Replaced ${replacedCount} existing todo item${replacedCount === 1 ? "" : "s"}; `;
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
		const status = task.status === "deferred" ? " {deferred}" : "";
		const blocked = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
		lines.push(`${"  ".repeat(depth)}- [${checked}] #${task.id} ${task.subject}${status}${blocked}`);
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
			if (!t) return `${formatReplacePrefix(op.replacedCount)}Created #${op.taskId}`;
			return `${formatReplacePrefix(op.replacedCount)}Created #${t.id}: ${t.subject} (pending)`;
		}
		case "update": {
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "batch_create":
			return `${formatReplacePrefix(op.replacedCount)}Created ${op.ids.length} tasks: ${op.ids.map((id) => `#${id}`).join(", ")}`;
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
	const text = appendWorkflowReminder(formatContent(op, state), op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}

function appendWorkflowReminder(text: string, op: Op, state: TaskState): string {
	if (op.kind === "error" || op.kind === "export") return text;
	const lines = [text];
	if (op.kind === "create" || op.kind === "batch_create") {
		lines.push(
			"Reminder: if this is a multi-step task, include a final todo item for the user-facing final report before completion. Give that final-report todo an explicit description/acceptance criteria: summarize changed files and behavior, list verification commands/results, mention any remaining manual action, and never replace the user-facing report with a compression/housekeeping note.",
		);
		const createdIds = new Set(op.kind === "create" ? [op.taskId] : op.ids);
		const hasOlderUnfinished = !op.replacedCount && state.tasks.some((task) => {
			if (createdIds.has(task.id)) return false;
			return task.status !== "completed" && task.status !== "deleted";
		});
		if (hasOlderUnfinished) {
			lines.push(
				"Reminder: existing unfinished todos are still present. If this is a new plan that supersedes them, use batch_create with replace:true or explicitly update/defer/delete obsolete tasks.",
			);
		}
	}
	const hasPending = state.tasks.some((task) => task.status === "pending");
	const hasInProgress = state.tasks.some((task) => task.status === "in_progress");
	if (hasPending && !hasInProgress) {
		lines.push(
			"Reminder: pending todos exist but none is in_progress. Before starting work, call todo update on exactly one task with status in_progress and activeForm.",
		);
	}
	if (hasInProgress) {
		lines.push(
			"Reminder: before your final response, update any finished todo items to completed. Treat the final user-facing report step like any other todo: mark it completed immediately before sending the report.",
		);
	}
	return lines.join("\n\n");
}
