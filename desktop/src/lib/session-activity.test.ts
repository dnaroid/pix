import { describe, expect, it } from "vitest";
import type { SessionSubagentSnapshot } from "./session-subagents";
import type { SessionTodoSnapshot } from "./session-todos";
import {
  sessionActivityLabel,
  sessionActivitySummary,
  sessionActivityTone,
  shouldAcceptSessionActivitySnapshot,
  updateSessionActivitySummary,
} from "./session-activity";

function todos(tasks: SessionTodoSnapshot["details"]["tasks"]): SessionTodoSnapshot {
  return {
    version: 1,
    details: { action: "list", params: {}, tasks, nextId: 20 },
    checkedAt: 1,
  };
}

function subagents(runs: SessionSubagentSnapshot["runs"]): SessionSubagentSnapshot {
  return {
    version: 1,
    count: runs.flatMap((run) => run.agents)
      .filter((agent) => agent.status === "planned" || agent.status === "running" || agent.status === "retrying")
      .length,
    runs,
    checkedAt: 1,
  };
}

describe("session activity summary", () => {
  it("combines read-only plan progress and only live subagents", () => {
    const summary = sessionActivitySummary(
      todos([
        { id: 1, subject: "Done", status: "completed" },
        { id: 2, subject: "Working", status: "in_progress" },
        { id: 3, subject: "Blocked", status: "pending", blockedBy: [2] },
        { id: 4, subject: "Removed", status: "deleted" },
      ]),
      subagents([{
        runDir: "/run",
        agents: [
          { id: "code", status: "running" },
          { id: "review", status: "retrying" },
          { id: "old", status: "done" },
        ],
      }]),
    );

    expect(summary).toEqual({
      activeSubagents: 2,
      retryingSubagents: 1,
      openTodos: 2,
      completedTodos: 1,
      totalTodos: 3,
      inProgressTodos: 1,
      blockedTodos: 1,
    });
    expect(sessionActivityTone(summary)).toBe("warning");
    expect(sessionActivityLabel(summary)).toBe("2 active subagents · Plan 1/3 · 1 retrying · 1 blocked");
  });

  it("uses info for active work and idle for a pending-only plan", () => {
    const active = sessionActivitySummary(
      todos([{ id: 1, subject: "Working", status: "in_progress" }]),
      undefined,
    );
    const pending = sessionActivitySummary(
      todos([{ id: 1, subject: "Later", status: "pending" }]),
      undefined,
    );
    expect(sessionActivityTone(active)).toBe("info");
    expect(sessionActivityTone(pending)).toBe("idle");
    expect(sessionActivityTone(pending, true)).toBe("info");
    expect(sessionActivityTone(pending, false, true)).toBe("warning");
    expect(sessionActivityLabel(pending)).toBe("Plan 0/1");
    expect(sessionActivityLabel(pending, false, true)).toBe("Needs input · Plan 0/1");
  });

  it("updates only the changed session summary for background tab indicators", () => {
    let summaryMap = updateSessionActivitySummary(
      new Map(),
      "a",
      todos([{ id: 1, subject: "A", status: "pending" }]),
      undefined,
    );
    const summaryA = summaryMap.get("a");
    summaryMap = updateSessionActivitySummary(
      summaryMap,
      "b",
      todos([{ id: 1, subject: "B", status: "completed" }]),
      subagents([{ runDir: "/b", agents: [{ id: "worker", status: "running" }] }]),
    );

    expect(summaryMap.get("a")?.openTodos).toBe(1);
    expect(summaryMap.get("a")?.activeSubagents).toBe(0);
    expect(summaryMap.get("a")).toBe(summaryA);
    expect(summaryMap.get("b")?.openTodos).toBe(0);
    expect(summaryMap.get("b")?.activeSubagents).toBe(1);
  });

  it("rejects stale or pre-forget snapshots while accepting a newer reopened-session snapshot", () => {
    expect(shouldAcceptSessionActivitySnapshot(90, 100, undefined)).toBe(false);
    expect(shouldAcceptSessionActivitySnapshot(100, 100, undefined)).toBe(true);
    expect(shouldAcceptSessionActivitySnapshot(110, 100, undefined)).toBe(true);
    expect(shouldAcceptSessionActivitySnapshot(110, undefined, 110)).toBe(false);
    expect(shouldAcceptSessionActivitySnapshot(111, undefined, 110)).toBe(true);
  });
});

