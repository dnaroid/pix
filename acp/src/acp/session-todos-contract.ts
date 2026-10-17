/** Shared read-only todo snapshot contract for ACP and Desktop. */
export type SessionTodoStatus = "pending" | "in_progress" | "deferred" | "completed" | "deleted";
export type SessionTodoThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SessionTodoAction = "create" | "update" | "batch_create" | "batch_update" | "list" | "get" | "delete" | "clear" | "export" | "import";

export interface SessionTodoTask {
  readonly id: number;
  readonly subject: string;
  readonly status: SessionTodoStatus;
  readonly description?: string;
  readonly activeForm?: string;
  readonly thinking?: SessionTodoThinking;
  readonly parentId?: number;
  readonly blockedBy?: number[];
  readonly owner?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionTodoSnapshot {
  readonly version: 1;
  readonly details: {
    readonly action: SessionTodoAction;
    readonly params: Record<string, unknown>;
    readonly tasks: SessionTodoTask[];
    readonly nextId: number;
    readonly error?: string;
  };
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly checkedAt: number;
}

const TODO_STATUSES: readonly SessionTodoStatus[] = ["pending", "in_progress", "deferred", "completed", "deleted"];
const THINKING_LEVELS: readonly SessionTodoThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TODO_ACTIONS: readonly SessionTodoAction[] = ["create", "update", "batch_create", "batch_update", "list", "get", "delete", "clear", "export", "import"];

export function isSessionTodoSnapshot(value: unknown): value is SessionTodoSnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.details)) return false;
  if (!Array.isArray(value.details.tasks) || !value.details.tasks.every(isSessionTodoTask)) return false;
  if (new Set(value.details.tasks.map((task) => task.id)).size !== value.details.tasks.length) return false;
  if (
    typeof value.details.action !== "string"
    || !TODO_ACTIONS.includes(value.details.action as SessionTodoAction)
    || !isRecord(value.details.params)
  ) return false;
  if (!isPositiveInteger(value.details.nextId) || !isFiniteNumber(value.checkedAt)) return false;
  if (value.details.error !== undefined && typeof value.details.error !== "string") return false;
  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  return true;
}

function isSessionTodoTask(value: unknown): value is SessionTodoTask {
  if (!isRecord(value) || !isPositiveInteger(value.id) || typeof value.subject !== "string") return false;
  if (typeof value.status !== "string" || !TODO_STATUSES.includes(value.status as SessionTodoStatus)) return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.activeForm !== undefined && typeof value.activeForm !== "string") return false;
  if (value.thinking !== undefined && (
    typeof value.thinking !== "string" || !THINKING_LEVELS.includes(value.thinking as SessionTodoThinking)
  )) return false;
  if (value.parentId !== undefined && !isPositiveInteger(value.parentId)) return false;
  if (value.blockedBy !== undefined && (
    !Array.isArray(value.blockedBy) || !value.blockedBy.every(isPositiveInteger)
  )) return false;
  if (value.owner !== undefined && typeof value.owner !== "string") return false;
  return value.metadata === undefined || isRecord(value.metadata);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
