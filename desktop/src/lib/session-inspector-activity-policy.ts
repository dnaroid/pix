import {
  visibleSessionSubagentRuns,
  type SessionSubagentSnapshot,
} from "./session-subagents";
import {
  visibleSessionTodoRows,
  type SessionTodoSnapshot,
} from "./session-todos";

export type SessionInspectorActivityTransition = "close" | null;

type SetSessionInspectorOpen = (open: boolean) => void;

/**
 * Session activity may close the inspector when there is nothing left to show,
 * but it never opens the inspector. Opening remains an explicit user action.
 */
export function createSessionInspectorActivityTracker() {
  function observe(
    sessionId: string | null,
    todoSnapshot: SessionTodoSnapshot | undefined,
    subagentSnapshot: SessionSubagentSnapshot | undefined,
  ): SessionInspectorActivityTransition {
    if (!sessionId) return null;
    return visibleSessionTodoRows(todoSnapshot).length === 0
      && visibleSessionSubagentRuns(subagentSnapshot).length === 0
      ? "close"
      : null;
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
  open: boolean,
  setOpen: SetSessionInspectorOpen,
): void {
  const transition = tracker.observe(sessionId, todoSnapshot, subagentSnapshot);
  if (open && transition === "close") setOpen(false);
}

export type SessionInspectorActivityTracker = ReturnType<typeof createSessionInspectorActivityTracker>;
