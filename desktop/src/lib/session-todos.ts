import type { SessionStateNotification } from "./session-state";

export const TODO_STATE_CHANNEL = "pi-tools-suite:todo:state";

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

export interface SessionTodoRow {
  readonly task: SessionTodoTask;
  readonly depth: number;
}

const TODO_STATUSES: readonly SessionTodoStatus[] = ["pending", "in_progress", "deferred", "completed", "deleted"];
const THINKING_LEVELS: readonly SessionTodoThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TODO_ACTIONS: readonly SessionTodoAction[] = ["create", "update", "batch_create", "batch_update", "list", "get", "delete", "clear", "export", "import"];

export function sessionTodoSnapshot(notification: SessionStateNotification): SessionTodoSnapshot | undefined {
  return notification.channel === TODO_STATE_CHANNEL && isSessionTodoSnapshot(notification.data)
    ? notification.data
    : undefined;
}

export function updateSessionTodoSnapshots(
  current: ReadonlyMap<string, SessionTodoSnapshot>,
  acpSessionId: string,
  snapshot: SessionTodoSnapshot,
): Map<string, SessionTodoSnapshot> {
  const previous = current.get(acpSessionId);
  if (previous && previous.checkedAt > snapshot.checkedAt) return new Map(current);
  const next = new Map(current);
  next.set(acpSessionId, snapshot);
  return next;
}

export function hasOpenSessionTodos(snapshot: SessionTodoSnapshot | undefined): boolean {
  return snapshot?.details.tasks.some((task) =>
    task.status === "pending" || task.status === "in_progress" || task.status === "deferred",
  ) ?? false;
}

/** Match the TUI: completed tasks are included only while an open task exists. */
export function visibleSessionTodoRows(snapshot: SessionTodoSnapshot | undefined): SessionTodoRow[] {
  if (!snapshot || !hasOpenSessionTodos(snapshot)) return [];
  const tasks = snapshot.details.tasks.filter((task) => task.status !== "deleted");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<number, SessionTodoTask[]>();
  const roots: SessionTodoTask[] = [];

  for (const task of tasks) {
    if (task.parentId !== undefined && task.parentId !== task.id && byId.has(task.parentId)) {
      children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
    } else {
      roots.push(task);
    }
  }

  const rows: SessionTodoRow[] = [];
  const emitted = new Set<number>();
  const emit = (task: SessionTodoTask, depth: number): void => {
    if (emitted.has(task.id)) return;
    emitted.add(task.id);
    rows.push({ task, depth });
    for (const child of children.get(task.id) ?? []) emit(child, depth + 1);
  };
  for (const task of roots) emit(task, 0);
  for (const task of tasks) emit(task, 0);
  return rows;
}

export function sessionTodoCounts(snapshot: SessionTodoSnapshot | undefined): Record<Exclude<SessionTodoStatus, "deleted">, number> {
  const counts = { pending: 0, in_progress: 0, deferred: 0, completed: 0 };
  for (const task of snapshot?.details.tasks ?? []) {
    if (task.status !== "deleted") counts[task.status] += 1;
  }
  return counts;
}

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
