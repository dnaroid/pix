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
import {
  sessionBrainstormSnapshot,
  updateSessionBrainstormSnapshots,
  type SessionBrainstormSnapshot,
} from "../lib/session-brainstorm";

type SessionActivityStoreOptions = {
  onChange?: (sessionId: string) => void;
};

export function createSessionActivityStore(options: SessionActivityStoreOptions = {}) {
  let todos = $state<Map<string, SessionTodoSnapshot>>(new Map());
  let subagents = $state<Map<string, SessionSubagentSnapshot>>(new Map());
  let summaries = $state<Map<string, SessionActivitySummary>>(new Map());
  let brainstorms = $state<Map<string, SessionBrainstormSnapshot>>(new Map());
  const owners = new Map<string, string>();
  const pending = new Map<string, Map<string, SessionStateNotification>>();

  function open(sessionId: string): string {
    let owner = owners.get(sessionId);
    if (!owner) {
      owner = crypto.randomUUID();
      owners.set(sessionId, owner);
    }
    return owner;
  }

  function beginRequest(owner: string): void { pending.set(owner, new Map()); }
  function cancelRequest(owner: string): void { pending.delete(owner); }
  function completeRequest(owner: string, sessionId: string): void {
    const snapshots = pending.get(owner);
    if (!snapshots) return; // reset/cancellation invalidated this request
    pending.delete(owner);
    owners.set(sessionId, owner);
    for (const notification of snapshots.values()) handle(notification);
  }

  function handle(notification: SessionStateNotification): boolean {
    const todoSnapshot = sessionTodoSnapshot(notification);
    if (todoSnapshot) {
      if (!notification.activityOwner || owners.get(notification.sessionId) !== notification.activityOwner) {
        stage(notification);
        return true;
      }
      const previous = todos.get(notification.sessionId);
      if (!shouldAcceptSessionActivitySnapshot(
        todoSnapshot.checkedAt,
        previous?.checkedAt,
      )) return true;
      todos = updateSessionTodoSnapshots(todos, notification.sessionId, todoSnapshot);
      summaries = updateSessionActivitySummary(
        summaries,
        notification.sessionId,
        todos.get(notification.sessionId),
        subagents.get(notification.sessionId),
      );
      options.onChange?.(notification.sessionId);
      return true;
    }

    const subagentSnapshot = sessionSubagentSnapshot(notification);
    const brainstormSnapshot = sessionBrainstormSnapshot(notification);
    if (!subagentSnapshot && !brainstormSnapshot) return false;
    if (!notification.activityOwner || owners.get(notification.sessionId) !== notification.activityOwner) {
      stage(notification);
      return true;
    }
    const previous = subagentSnapshot ? subagents.get(notification.sessionId) : brainstorms.get(notification.sessionId);
    const checkedAt = subagentSnapshot?.checkedAt ?? brainstormSnapshot!.checkedAt;
    if (!shouldAcceptSessionActivitySnapshot(
      checkedAt,
      previous?.checkedAt,
    )) return true;
    if (subagentSnapshot) subagents = updateSessionSubagentSnapshots(subagents, notification.sessionId, subagentSnapshot);
    if (brainstormSnapshot) brainstorms = updateSessionBrainstormSnapshots(brainstorms, notification.sessionId, brainstormSnapshot);
    summaries = updateSessionActivitySummary(
      summaries,
      notification.sessionId,
      todos.get(notification.sessionId),
      subagents.get(notification.sessionId),
    );
    options.onChange?.(notification.sessionId);
    return true;
  }

  function markForgotten(sessionId: string): void {
    owners.delete(sessionId);
    // Abandoned new/fork requests may forget without the tab-close clear path.
    // Snapshots and their ordering timestamps belong to the attachment too.
    clear(sessionId);
  }

  function stage(notification: SessionStateNotification): void {
    const snapshots = notification.activityOwner && pending.get(notification.activityOwner);
    if (!snapshots) return;
    const prior = snapshots.get(notification.channel);
    const current = sessionTodoSnapshot(notification) ?? sessionSubagentSnapshot(notification) ?? sessionBrainstormSnapshot(notification);
    const previous = prior && (sessionTodoSnapshot(prior) ?? sessionSubagentSnapshot(prior) ?? sessionBrainstormSnapshot(prior));
    if (current && shouldAcceptSessionActivitySnapshot(current.checkedAt, previous?.checkedAt)) {
      snapshots.set(notification.channel, notification);
    }
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
    if (brainstorms.has(sessionId)) {
      const next = new Map(brainstorms);
      next.delete(sessionId);
      brainstorms = next;
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
    brainstorms = new Map();
    summaries = new Map();
    owners.clear();
    pending.clear();
  }

  return {
    get ownedSessionCount() { return owners.size; },
    get pendingRequestCount() { return pending.size; },
    get todos() { return todos; },
    get subagents() { return subagents; },
    get brainstorms() { return brainstorms; },
    get summaries() { return summaries; },
    handle,
    open,
    beginRequest,
    cancelRequest,
    completeRequest,
    markForgotten,
    clear,
    reset,
  };
}
