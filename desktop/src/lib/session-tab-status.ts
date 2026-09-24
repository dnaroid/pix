import type { SessionActivitySummary } from "./session-activity";

export type SessionTabStatusKind =
  | "idle"
  | "paused"
  | "running"
  | "needs-input"
  | "warning"
  | "unseen-complete";

export function sessionTabStatusKind(options: {
  activity: SessionActivitySummary | undefined;
  paused: boolean;
  running: boolean;
  needsInput: boolean;
  unseenComplete: boolean;
}): SessionTabStatusKind {
  if (options.needsInput) return "needs-input";
  if ((options.activity?.retryingSubagents ?? 0) > 0 || (options.activity?.blockedTodos ?? 0) > 0) {
    return "warning";
  }
  if (options.paused) return "paused";
  if (
    options.running
    || (options.activity?.activeSubagents ?? 0) > 0
    || (options.activity?.inProgressTodos ?? 0) > 0
  ) return "running";
  if (options.unseenComplete) return "unseen-complete";
  return "idle";
}

export function sessionTabStatusLabel(
  kind: SessionTabStatusKind,
  activityLabel: string,
): string {
  if (kind === "paused") return "Paused";
  return kind === "unseen-complete" ? "Completed · not viewed" : activityLabel;
}
