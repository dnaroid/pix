/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the pre-refactor import surface so that
 * `index.ts` and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { TODO_TOOL_DESCRIPTION } from "../tool-descriptions.js";
import {
	disablePersistence,
	getTodoPlanPath,
	loadPersistedPlan,
	savePersistedPlan,
	syncPersistedPlan,
} from "./state/persistence.js";
import { AUTO_CLEAR_COMPLETED_MESSAGE, autoClearCompletedTodos } from "./state/auto-clear.js";
import { replayFromBranch } from "./state/replay.js";
import { isTaskBlocked, selectTasksByStatus, selectTodoCounts } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { activateStateScope, commitState, getState, replaceState } from "./state/store.js";
import { buildToolResult, formatContent } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type Task,
	type TaskAction,
	type TaskMutationParams,
	type TaskStatus,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { formatCommandTaskLine } from "./view/format.js";
import { formatStatusLabel } from "./view/labels.js";

const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_DEFERRED = "── Deferred ──";
const SECTION_COMPLETED = "── Completed ──";
const PERSIST_COMMAND_NAME = "todos-persist";
const SCOPE_COMMAND_NAME = "todos-scope";
export const TODO_STATE_EVENT = "pi-tools-suite:todo:state";

type CommandCompletion = { value: string; label: string; description?: string };

const TODOS_ARGUMENT_COMPLETIONS: CommandCompletion[] = [
	{ value: "persist on", label: "persist on", description: "Enable project plan persistence" },
	{ value: "persist status", label: "persist status", description: "Show project plan persistence status" },
	{ value: "persist off", label: "persist off", description: "Disable persistence and remove the project plan file" },
	{ value: "persist clear", label: "persist clear", description: "Alias for persist off" },
	{ value: "scope ", label: "scope <id...>", description: "Keep selected items active and defer out-of-scope items" },
	{ value: "--active", label: "--active", description: "Show pending/in_progress tasks" },
	{ value: "--ready", label: "--ready", description: "Show pending tasks whose blockers are completed" },
	{ value: "--blocked", label: "--blocked", description: "Show tasks with blockers" },
	{ value: "--tree", label: "--tree", description: "Show parent/subtask tree" },
	{ value: "--status ", label: "--status <status>", description: "Filter by status" },
	{ value: "--export markdown", label: "--export markdown", description: "Export visible todos as Markdown" },
	{ value: "--export json", label: "--export json", description: "Export visible todos as JSON" },
];

const PERSIST_ARGUMENT_COMPLETIONS: CommandCompletion[] = [
	{ value: "on", label: "on", description: "Enable project plan persistence" },
	{ value: "status", label: "status", description: "Show persistence status" },
	{ value: "off", label: "off", description: "Disable persistence and remove the plan file" },
	{ value: "clear", label: "clear", description: "Alias for off" },
];

interface TodoToolHooks {
	prepareMutation?: (
		state: ReturnType<typeof getState>,
		ctx: ExtensionContext,
		info: { action: TaskAction; params: TaskMutationParams },
	) => TaskMutationParams | Promise<TaskMutationParams>;
	afterCommit?: (
		state: ReturnType<typeof getState>,
		ctx: ExtensionContext,
		info: { action: TaskAction; params: TaskMutationParams; committedState: ReturnType<typeof getState> },
	) => void | Promise<void>;
}

interface TodoToolRegistrationOptions extends TodoToolHooks {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

type TodoStateEventContext = { sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown } };
type TodoStateEventEmitter = { events?: { emit?: (channel: string, data: unknown) => void } };

interface TodosCommandOptions {
	status?: TaskStatus;
	blockedOnly: boolean;
	readyOnly: boolean;
	activeOnly: boolean;
	includeDeleted: boolean;
	tree: boolean;
	exportFormat?: "json" | "markdown";
}

function parseTodosArgs(args: unknown): TodosCommandOptions {
	const text = typeof args === "string" ? args : Array.isArray(args) ? args.join(" ") : "";
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	const options: TodosCommandOptions = {
		blockedOnly: false,
		readyOnly: false,
		activeOnly: false,
		includeDeleted: false,
		tree: false,
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const next = tokens[i + 1];
		switch (token) {
			case "--blocked":
				options.blockedOnly = true;
				break;
			case "--ready":
				options.readyOnly = true;
				break;
			case "--active":
				options.activeOnly = true;
				break;
			case "--tree":
				options.tree = true;
				break;
			case "--include-deleted":
				options.includeDeleted = true;
				break;
			case "--status":
				if (next === "pending" || next === "in_progress" || next === "deferred" || next === "completed" || next === "deleted") options.status = tokens[++i] as TaskStatus;
				break;
			case "--export":
				options.exportFormat = next === "markdown" ? "markdown" : "json";
				if (next === "json" || next === "markdown") i++;
				break;
		}
	}
	return options;
}

function getCommandText(args: unknown): string {
	return typeof args === "string" ? args : Array.isArray(args) ? args.join(" ") : "";
}

function getCommandTokens(args: unknown): string[] {
	return getCommandText(args).trim().split(/\s+/).filter(Boolean);
}

function completeCommandArguments(prefix: string, completions: readonly CommandCompletion[]): CommandCompletion[] {
	const normalizedPrefix = prefix.trimStart();
	return completions.filter((completion) => completion.value.startsWith(normalizedPrefix));
}

function parseScopeIds(tokens: readonly string[]): number[] {
	const ids = tokens
		.flatMap((token) => token.split(/[\s,]+/))
		.map((token) => Number(token.replace(/^#/, "")))
		.filter((id) => Number.isFinite(id) && id > 0);
	return [...new Set(ids)];
}

function scopeStatus(task: Task, selected: ReadonlySet<number>): TaskStatus {
	if (selected.has(task.id)) {
		if (task.status === "deferred") return "pending";
		return task.status;
	}
	if (task.status === "pending" || task.status === "in_progress") return "deferred";
	return task.status;
}

type NotifyLevel = "info" | "warning" | "error";

function notifyCommand(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level?: NotifyLevel) => void } }, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") console.error(message);
	else console.log(message);
}

function sessionFileFromContext(ctx: unknown): string | undefined {
	const sessionFile = (ctx as TodoStateEventContext | undefined)?.sessionManager?.getSessionFile?.();
	return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : undefined;
}

function sessionIdFromContext(ctx: unknown): string | undefined {
	const sessionId = (ctx as TodoStateEventContext | undefined)?.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

function todoStateScopeFromContext(ctx: unknown): string | undefined {
	const sessionFile = sessionFileFromContext(ctx);
	if (sessionFile) return `file:${resolve(sessionFile)}`;
	const sessionId = sessionIdFromContext(ctx);
	if (sessionId) return `id:${sessionId}`;
	const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
	return typeof cwd === "string" && cwd.trim() ? `cwd:${resolve(cwd)}` : undefined;
}

export function activateTodoStateScope(ctx: unknown): void {
	activateStateScope(todoStateScopeFromContext(ctx));
}

export function publishTodoState(
	pi: TodoStateEventEmitter,
	ctx: unknown,
	action: TaskAction = "list",
	params: Record<string, unknown> = {},
): void {
	activateTodoStateScope(ctx);
	const state = getState();
	const sessionFile = sessionFileFromContext(ctx);
	const sessionId = sessionIdFromContext(ctx);
	pi.events?.emit?.(TODO_STATE_EVENT, {
		version: 1,
		details: {
			action,
			params,
			tasks: state.tasks,
			nextId: state.nextId,
		},
		...(sessionFile ? { sessionFile } : {}),
		...(sessionId ? { sessionId } : {}),
		checkedAt: Date.now(),
	});
}

function handlePersistCommand(args: unknown, ctx: { cwd?: string; hasUI?: boolean; ui?: { notify?: (message: string, level?: NotifyLevel) => void } }): boolean {
	const [command, subcommand = "status"] = getCommandTokens(args);
	if (command !== "persist") return false;

	const cwd = ctx.cwd;
	switch (subcommand) {
		case "on": {
			const path = savePersistedPlan(cwd, getState());
			notifyCommand(ctx, `Todo persistence enabled: ${path}`);
			return true;
		}
		case "off":
		case "clear": {
			const path = disablePersistence(cwd);
			notifyCommand(ctx, `Todo persistence disabled and project plan removed: ${path}`);
			return true;
		}
		case "status": {
			const loaded = loadPersistedPlan(cwd);
			if (!loaded) {
				notifyCommand(ctx, `Todo persistence is off (${getTodoPlanPath(cwd)} not found)`);
				return true;
			}
			const visible = loaded.state.tasks.filter((task) => task.status !== "deleted").length;
			const active = loaded.state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress").length;
			notifyCommand(ctx, `Todo persistence is on: ${loaded.path}\n${visible} visible tasks, ${active} active.`);
			return true;
		}
		default:
			notifyCommand(ctx, "Usage: /todos persist on|off|clear|status", "error");
			return true;
	}
}

function handleScopeCommand(
	args: unknown,
	ctx: { cwd?: string; hasUI?: boolean; ui?: { notify?: (message: string, level?: NotifyLevel) => void } },
	afterCommit?: () => void,
): boolean {
	const [command, ...rest] = getCommandTokens(args);
	if (command !== "scope") return false;
	const selectedIds = parseScopeIds(rest);
	if (selectedIds.length === 0) {
		notifyCommand(ctx, "Usage: /todos scope <id> [id...]", "error");
		return true;
	}

	const selected = new Set(selectedIds);
	let nextState = getState();
	const changed: number[] = [];
	for (const task of nextState.tasks) {
		if (task.status === "deleted" || task.status === "completed") continue;
		const nextStatus = scopeStatus(task, selected);
		if (nextStatus === task.status) continue;
		const result = applyTaskMutation(nextState, "update", { action: "update", id: task.id, status: nextStatus });
		if (result.op.kind === "error") {
			notifyCommand(ctx, result.op.message, "error");
			return true;
		}
		nextState = result.state;
		changed.push(task.id);
	}
	commitState(nextState);
	afterCommit?.();
	const sync = syncPersistedPlan(ctx.cwd, nextState);
	const selectedText = selectedIds.map((id) => `#${id}`).join(", ");
	const persistedText = sync ? `\nPersisted plan updated: ${sync.path}` : "";
	notifyCommand(ctx, `Todo scope selected: ${selectedText}\nDeferred out-of-scope active tasks: ${changed.length}${persistedText}`);
	return true;
}

function filterCommandTasks(tasks: readonly Task[], options: TodosCommandOptions): Task[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	let view = [...tasks];
	if (!options.includeDeleted) view = view.filter((task) => task.status !== "deleted");
	if (options.activeOnly) view = view.filter((task) => task.status === "pending" || task.status === "in_progress");
	if (options.readyOnly) {
		view = view.filter((task) => task.status === "pending" && !isTaskBlocked(task, byId));
	}
	if (options.status) view = view.filter((task) => task.status === options.status);
	if (options.blockedOnly) view = view.filter((task) => (task.blockedBy?.length ?? 0) > 0);
	return view;
}

function commandGlyph(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "○";
		case "in_progress":
			return "◐";
		case "deferred":
			return "◌";
		case "completed":
			return "✓";
		case "deleted":
			return "⊘";
	}
}

function formatCommandTree(tasks: readonly Task[]): string[] {
	const byParent = new Map<number | undefined, Task[]>();
	const ids = new Set(tasks.map((task) => task.id));
	for (const task of tasks) {
		const parent = task.parentId !== undefined && ids.has(task.parentId) ? task.parentId : undefined;
		const siblings = byParent.get(parent) ?? [];
		siblings.push(task);
		byParent.set(parent, siblings);
	}
	const lines: string[] = [];
	const seen = new Set<number>();
	const visit = (task: Task, depth: number) => {
		if (seen.has(task.id)) return;
		seen.add(task.id);
		lines.push(`${"  ".repeat(depth)}${formatCommandTaskLine(task, commandGlyph(task.status)).trimStart()}`);
		for (const child of byParent.get(task.id) ?? []) visit(child, depth + 1);
	};
	for (const root of byParent.get(undefined) ?? []) visit(root, 0);
	for (const task of tasks) visit(task, 0);
	return lines;
}

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

/**
 * Backward-compat replay shim. Pre-refactor `reconstructTodoState(ctx)`
 * mutated module state directly; the new replay seam (`state/replay.ts`)
 * returns a `TaskState` and the caller commits via `replaceState`.
 */
export function reconstructTodoState(ctx: Parameters<typeof replayFromBranch>[0]): void {
	replaceState(replayFromBranch(ctx));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = TODO_TOOL_DESCRIPTION.promptSnippet ?? "";
export const DEFAULT_PROMPT_GUIDELINES: string[] = TODO_TOOL_DESCRIPTION.promptGuidelines ?? [];

export function registerTodoTool(pi: ExtensionAPI, hooks: TodoToolRegistrationOptions = {}): void {
	pi.registerTool({
		...TODO_TOOL_DESCRIPTION,
		name: TOOL_NAME,
		label: TOOL_LABEL,
		promptSnippet: hooks.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: hooks.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			activateTodoStateScope(_ctx);
			const preparedParams = await hooks.prepareMutation?.(getState(), _ctx as ExtensionContext, {
				action: params.action,
				params: params as TaskMutationParams,
			}) ?? params as TaskMutationParams;
			const result = applyTaskMutation(getState(), params.action, preparedParams);
			if (result.op.kind === "error") {
				throw new Error(result.op.message);
			}
			const autoClear = autoClearCompletedTodos(result.state);
			commitState(autoClear.state);
			publishTodoState(pi as TodoStateEventEmitter, _ctx, params.action, params as Record<string, unknown>);
			await hooks.afterCommit?.(result.state, _ctx as ExtensionContext, {
				action: params.action,
				params: preparedParams,
				committedState: autoClear.state,
			});
			const toolResult = buildToolResult(params.action, preparedParams, autoClear.state, result.op);
			if (!autoClear.cleared) return toolResult;
			return {
				...toolResult,
				content: [{ type: "text" as const, text: `${toolResult.content[0]?.text ?? ""}\n${AUTO_CLEAR_COMPLETED_MESSAGE}`.trim() }],
			};
		},

	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
	description: "Show todos on the current branch. Flags: --active, --ready, --blocked, --tree, --status <status>, --export [json|markdown]. Commands: persist on|off|clear|status, scope <id...>",
		getArgumentCompletions: (prefix) => completeCommandArguments(String(prefix ?? ""), TODOS_ARGUMENT_COMPLETIONS),
		handler: async (args, ctx) => {
			activateTodoStateScope(ctx);
			if (handlePersistCommand(args, ctx)) return;
			if (handleScopeCommand(args, ctx, () => publishTodoState(pi as TodoStateEventEmitter, ctx))) return;
			if (!ctx.hasUI) {
				console.error(ERR_REQUIRES_INTERACTIVE);
				return;
			}
			const state = getState();
			const options = parseTodosArgs(args);
			if (options.exportFormat) {
				const exportState = { tasks: filterCommandTasks(state.tasks, options), nextId: state.nextId };
				const op = {
					kind: "export" as const,
					format: options.exportFormat,
					includeDeleted: options.includeDeleted,
					blockedOnly: options.blockedOnly,
					...(options.status ? { statusFilter: options.status } : {}),
				};
				ctx.ui.notify(formatContent(op, exportState), "info");
				return;
			}

			const visible = filterCommandTasks(state.tasks, options);
			if (visible.length === 0) {
				ctx.ui.notify(MSG_NO_TODOS, "info");
				return;
			}
			const filteredState = { tasks: visible, nextId: state.nextId };
			const groups = selectTasksByStatus(filteredState);
			const counts = selectTodoCounts(filteredState);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);
			if (counts.deferred > 0) header.push(`${counts.deferred} ${formatStatusLabel("deferred")}`);

			const lines: string[] = [header.join(" · ")];
			if (options.tree) {
				lines.push("── Tree ──");
				lines.push(...formatCommandTree(visible));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (groups.pending.length > 0) {
				lines.push(SECTION_PENDING);
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(SECTION_IN_PROGRESS);
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.deferred.length > 0) {
				lines.push(SECTION_DEFERRED);
				for (const task of groups.deferred) lines.push(formatCommandTaskLine(task, "◌"));
			}
			if (groups.completed.length > 0) {
				lines.push(SECTION_COMPLETED);
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand(PERSIST_COMMAND_NAME, {
		description: "Enable, disable, clear, or inspect project todo persistence. Args: on|off|clear|status.",
		getArgumentCompletions: (prefix) => completeCommandArguments(String(prefix ?? ""), PERSIST_ARGUMENT_COMPLETIONS),
		handler: async (args, ctx) => {
			activateTodoStateScope(ctx);
			handlePersistCommand(`persist ${getCommandText(args)}`, ctx);
		},
	});

	pi.registerCommand(SCOPE_COMMAND_NAME, {
		description: "Select todo ids to continue from a persisted plan; pending/in_progress items outside the scope become deferred.",
		handler: async (args, ctx) => {
			activateTodoStateScope(ctx);
			handleScopeCommand(`scope ${getCommandText(args)}`, ctx, () => publishTodoState(pi as TodoStateEventEmitter, ctx));
		},
	});
}
