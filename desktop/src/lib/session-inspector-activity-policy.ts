import {
  visibleSessionSubagentRuns,
  type SessionSubagentSnapshot,
} from "./session-subagents";
import {
  visibleSessionTodoRows,
  type SessionTodoSnapshot,
} from "./session-todos";

export type SessionInspectorActivityTransition = "open" | "close" | null;

type SetSessionInspectorOpen = (open: boolean) => void;

/**
 * Tracks the visible activity identities observed for each active session.
 * It intentionally ignores content/status updates so a user's manual inspector
 * choice is retained until visible activity is added or fully cleared.
 */
export function createSessionInspectorActivityTracker() {
  const identitiesBySession = new Map<string, ReadonlySet<string>>();

  function observe(
    sessionId: string | null,
    todoSnapshot: SessionTodoSnapshot | undefined,
    subagentSnapshot: SessionSubagentSnapshot | undefined,
  ): SessionInspectorActivityTransition {
    if (!sessionId) return null;

    const next = visibleActivityIdentities(todoSnapshot, subagentSnapshot);
    const previous = identitiesBySession.get(sessionId);
    identitiesBySession.set(sessionId, next);

    // First display is a decision, not merely a transition: a restored/open
    // inspector must not remain visible for an empty session, and a session
    // that already has activity must not stay hidden just because its snapshot
    // arrived before this active-tab effect.
    if (!previous) return next.size > 0 ? "open" : "close";
    if (previous.size > 0 && next.size === 0) return "close";
    return hasNewIdentity(previous, next) ? "open" : null;
  }

  return {
    observe,
  };
}

export function syncSessionInspectorActivity(
  tracker: SessionInspectorActivityTracker,
  sessionId: string | null,
  todoSnapshot: SessionTodoSnapshot | undefined,
  subagentSnapshot: SessionSubagentSnapshot | undefined,
  setOpen: SetSessionInspectorOpen,
): void {
  const transition = tracker.observe(sessionId, todoSnapshot, subagentSnapshot);
  if (transition) setOpen(transition === "open");
}

function visibleActivityIdentities(
  todoSnapshot: SessionTodoSnapshot | undefined,
  subagentSnapshot: SessionSubagentSnapshot | undefined,
): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const { task } of visibleSessionTodoRows(todoSnapshot)) {
    identities.add(`todo:${task.id}`);
  }
  for (const run of visibleSessionSubagentRuns(subagentSnapshot)) {
    for (const agent of run.agents) {
      identities.add(`subagent:${JSON.stringify([run.runDir, agent.id])}`);
    }
  }
  return identities;
}

function hasNewIdentity(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  for (const identity of next) {
    if (!previous.has(identity)) return true;
  }
  return false;
}

export type SessionInspectorActivityTracker = ReturnType<typeof createSessionInspectorActivityTracker>;
