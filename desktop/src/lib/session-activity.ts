import { sessionTodoCounts, type SessionTodoSnapshot } from "./session-todos";
import {
  isActiveSessionSubagentStatus,
  type SessionSubagentSnapshot,
} from "./session-subagents";

export type SessionActivityTone = "idle" | "info" | "warning";

export interface SessionActivitySummary {
  readonly activeSubagents: number;
  readonly retryingSubagents: number;
  readonly openTodos: number;
  readonly completedTodos: number;
  readonly totalTodos: number;
  readonly inProgressTodos: number;
  readonly blockedTodos: number;
}

export const EMPTY_SESSION_ACTIVITY: SessionActivitySummary = {
  activeSubagents: 0,
  retryingSubagents: 0,
  openTodos: 0,
  completedTodos: 0,
  totalTodos: 0,
  inProgressTodos: 0,
  blockedTodos: 0,
};

export function sessionActivitySummary(
  todoSnapshot: SessionTodoSnapshot | undefined,
  subagentSnapshot: SessionSubagentSnapshot | undefined,
): SessionActivitySummary {
  const counts = sessionTodoCounts(todoSnapshot);
  const nonDeletedTodos = todoSnapshot?.details.tasks.filter((task) => task.status !== "deleted") ?? [];
  const activeAgents = (subagentSnapshot?.runs ?? [])
    .flatMap((run) => run.agents)
    .filter((agent) => isActiveSessionSubagentStatus(agent.status));

  return {
    activeSubagents: activeAgents.length,
    retryingSubagents: activeAgents.filter((agent) => agent.status === "retrying").length,
    openTodos: counts.pending + counts.in_progress + counts.deferred,
    completedTodos: counts.completed,
    totalTodos: nonDeletedTodos.length,
    inProgressTodos: counts.in_progress,
    blockedTodos: nonDeletedTodos.filter((task) => task.status !== "completed" && (task.blockedBy?.length ?? 0) > 0).length,
  };
}

export function updateSessionActivitySummary(
  current: ReadonlyMap<string, SessionActivitySummary>,
  sessionId: string,
  todoSnapshot: SessionTodoSnapshot | undefined,
  subagentSnapshot: SessionSubagentSnapshot | undefined,
): Map<string, SessionActivitySummary> {
  const next = new Map(current);
  next.set(sessionId, sessionActivitySummary(todoSnapshot, subagentSnapshot));
  return next;
}

export function shouldAcceptSessionActivitySnapshot(
  checkedAt: number,
  currentCheckedAt: number | undefined,
  forgottenAt: number | undefined,
): boolean {
  if (forgottenAt !== undefined && checkedAt <= forgottenAt) return false;
  return currentCheckedAt === undefined || checkedAt >= currentCheckedAt;
}

export function sessionActivityTone(
  summary: SessionActivitySummary | undefined,
  promptRunning = false,
  needsInput = false,
): SessionActivityTone {
  if (needsInput || (summary?.retryingSubagents ?? 0) > 0 || (summary?.blockedTodos ?? 0) > 0) return "warning";
  if (promptRunning || (summary?.activeSubagents ?? 0) > 0 || (summary?.inProgressTodos ?? 0) > 0) return "info";
  return "idle";
}

export function sessionActivityLabel(
  summary: SessionActivitySummary | undefined,
  promptRunning = false,
  needsInput = false,
): string {
  const state = summary ?? EMPTY_SESSION_ACTIVITY;
  const parts: string[] = [];
  if (needsInput) parts.push("Needs input");
  if (promptRunning) parts.push("Session running");
  if (state.activeSubagents > 0) {
    parts.push(`${state.activeSubagents} active ${state.activeSubagents === 1 ? "subagent" : "subagents"}`);
  }
  if (state.openTodos > 0 && state.totalTodos > 0) parts.push(`Plan ${state.completedTodos}/${state.totalTodos}`);
  if (state.retryingSubagents > 0) parts.push(`${state.retryingSubagents} retrying`);
  if (state.blockedTodos > 0) parts.push(`${state.blockedTodos} blocked`);
  return parts.length > 0 ? parts.join(" · ") : "Session idle";
}

