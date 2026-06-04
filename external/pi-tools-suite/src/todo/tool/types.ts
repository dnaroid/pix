import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "deferred" | "completed" | "deleted";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TodoThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type TaskAction = "create" | "update" | "batch_create" | "batch_update" | "list" | "get" | "delete" | "clear" | "export" | "import";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	priority?: TaskPriority;
	thinking?: TodoThinkingLevel;
	parentId?: number;
	blockedBy?: number[];
	tags?: string[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	thinking?: TodoThinkingLevel;
	parentId?: number | null;
	clearParent?: boolean;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	tags?: string[];
	addTags?: string[];
	removeTags?: string[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	tag?: string;
	blockedOnly?: boolean;
	items?: TaskMutationParams[];
	format?: "json" | "markdown";
	content?: string;
	replace?: boolean;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "batch_create", "batch_update", "list", "get", "delete", "clear", "export", "import"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "deferred", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	priority: Type.Optional(
		StringEnum(["low", "medium", "high", "urgent"] as const, {
			description: "Task priority (create/update) or list/export filter (list/export)",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "Per-task thinking level used when todoThinking is enabled and this task is in_progress",
		}),
	),
	parentId: Type.Optional(
		Type.Number({
			description: "Parent task id for hierarchy/subtasks (create/update); must refer to a non-deleted task",
		}),
	),
	clearParent: Type.Optional(
		Type.Boolean({
			description: "Remove the parentId from a task (update only)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tags to set on create/update, replacing the previous tag list",
		}),
	),
	addTags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tags to add on update without replacing existing tags",
		}),
	),
	removeTags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tags to remove on update",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
	tag: Type.Optional(Type.String({ description: "Tag filter for list/export" })),
	blockedOnly: Type.Optional(Type.Boolean({ description: "If true, list only tasks blocked by another task" })),
	items: Type.Optional(
		Type.Array(Type.Record(Type.String(), Type.Unknown()), {
			description: "Batch items for batch_create or batch_update; each item uses the same fields as create/update",
		}),
	),
	format: Type.Optional(
		StringEnum(["json", "markdown"] as const, {
			description: "Import/export format. Default: json.",
		}),
	),
	content: Type.Optional(Type.String({ description: "Import content for action=import" })),
	replace: Type.Optional(Type.Boolean({ description: "For import, replace existing tasks instead of appending. Default: false." })),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
