import type { SessionStateNotification } from "../lib/session-state";
import {
  shouldAcceptSessionActivitySnapshot,
  updateSessionActivitySummary,
  type SessionActivitySummary,
} from "../lib/session-activity";
import {
  sessionTodoSnapshot,
  updateSessionTodoSnapshots,
  type SessionTodoSnapshot,
} from "../lib/session-todos";
import {
  sessionSubagentSnapshot,
  updateSessionSubagentSnapshots,
  type SessionSubagentSnapshot,
} from "../lib/session-subagents";

export function createSessionActivityStore() {
  let todos = $state<Map<string, SessionTodoSnapshot>>(new Map());
  let subagents = $state<Map<string, SessionSubagentSnapshot>>(new Map());
  let summaries = $state<Map<string, SessionActivitySummary>>(new Map());
  const forgottenAt = new Map<string, number>();

  function handle(notification: SessionStateNotification): boolean {
    const todoSnapshot = sessionTodoSnapshot(notification);
    if (todoSnapshot) {
      const previous = todos.get(notification.sessionId);
      if (!shouldAcceptSessionActivitySnapshot(
        todoSnapshot.checkedAt,
        previous?.checkedAt,
        forgottenAt.get(notification.sessionId),
      )) return true;
      todos = updateSessionTodoSnapshots(todos, notification.sessionId, todoSnapshot);
      summaries = updateSessionActivitySummary(
        summaries,
        notification.sessionId,
        todos.get(notification.sessionId),
        subagents.get(notification.sessionId),
      );
      return true;
    }

    const subagentSnapshot = sessionSubagentSnapshot(notification);
    if (!subagentSnapshot) return false;
    const previous = subagents.get(notification.sessionId);
    if (!shouldAcceptSessionActivitySnapshot(
      subagentSnapshot.checkedAt,
      previous?.checkedAt,
      forgottenAt.get(notification.sessionId),
    )) return true;
    subagents = updateSessionSubagentSnapshots(subagents, notification.sessionId, subagentSnapshot);
    summaries = updateSessionActivitySummary(
      summaries,
      notification.sessionId,
      todos.get(notification.sessionId),
      subagents.get(notification.sessionId),
    );
    return true;
  }

  function markForgotten(sessionId: string): void {
    forgottenAt.set(sessionId, Math.max(forgottenAt.get(sessionId) ?? 0, Date.now()));
  }

  function clear(sessionId: string): void {
    if (todos.has(sessionId)) {
      const next = new Map(todos);
      next.delete(sessionId);
      todos = next;
    }
    if (subagents.has(sessionId)) {
      const next = new Map(subagents);
      next.delete(sessionId);
      subagents = next;
    }
    if (summaries.has(sessionId)) {
      const next = new Map(summaries);
      next.delete(sessionId);
      summaries = next;
    }
  }

  function reset(): void {
    todos = new Map();
    subagents = new Map();
    summaries = new Map();
    forgottenAt.clear();
  }

  return {
    get todos() { return todos; },
    get subagents() { return subagents; },
    get summaries() { return summaries; },
    handle,
    markForgotten,
    clear,
    reset,
  };
}
