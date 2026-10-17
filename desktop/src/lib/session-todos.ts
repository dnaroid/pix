import { isSessionTodoSnapshot, type SessionTodoStatus, type SessionTodoTask, type SessionTodoSnapshot } from "../../../acp/src/acp/session-todos-contract";
import type { SessionStateNotification } from "./session-state";

export type { SessionTodoStatus, SessionTodoThinking, SessionTodoAction, SessionTodoTask, SessionTodoSnapshot } from "../../../acp/src/acp/session-todos-contract";
export { isSessionTodoSnapshot };

export const TODO_STATE_CHANNEL = "pi-tools-suite:todo:state";

export interface SessionTodoRow {
  readonly task: SessionTodoTask;
  readonly depth: number;
}

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

export function currentSessionTodoTask(snapshot: SessionTodoSnapshot | undefined): SessionTodoTask | undefined {
  const tasks = snapshot?.details.tasks ?? [];
  return tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "pending")
    ?? tasks.find((task) => task.status === "deferred");
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
