import { describe, expect, it } from "vitest";
import type { SessionStateNotification } from "./session-state";
import {
  hasOpenSessionTodos,
  sessionTodoCounts,
  sessionTodoSnapshot,
  updateSessionTodoSnapshots,
  visibleSessionTodoRows,
  type SessionTodoSnapshot,
} from "./session-todos";

function snapshot(tasks: SessionTodoSnapshot["details"]["tasks"], checkedAt = 1): SessionTodoSnapshot {
  return {
    version: 1,
    details: { action: "list", params: {}, tasks: [...tasks], nextId: 10 },
    checkedAt,
  };
}

function notification(data: unknown, channel = "pi-tools-suite:todo:state"): SessionStateNotification {
  return { sessionId: "acp-1", channel, data };
}

describe("desktop session todos", () => {
  it("validates the channel and versioned todo snapshot", () => {
    const valid = snapshot([{ id: 1, subject: "Implement", status: "pending", thinking: "high" }]);
    expect(sessionTodoSnapshot(notification(valid))).toEqual(valid);
    expect(sessionTodoSnapshot(notification(valid, "other"))).toBeUndefined();
    expect(sessionTodoSnapshot(notification({ ...valid, version: 2 }))).toBeUndefined();
    expect(sessionTodoSnapshot(notification({ ...valid, checkedAt: Number.NaN }))).toBeUndefined();
    expect(sessionTodoSnapshot(notification({
      ...valid,
      details: { ...valid.details, action: "unknown" },
    }))).toBeUndefined();
    expect(sessionTodoSnapshot(notification(snapshot([
      { id: 1, subject: "First", status: "pending" },
      { id: 1, subject: "Duplicate", status: "completed" },
    ])))).toBeUndefined();
    expect(sessionTodoSnapshot(notification(snapshot([
      { id: 1.5, subject: "Fractional id", status: "pending" },
    ])))).toBeUndefined();
  });

  it("excludes deleted tasks and preserves parent-first stable hierarchy", () => {
    const state = snapshot([
      { id: 2, subject: "Child", status: "in_progress", parentId: 1 },
      { id: 1, subject: "Parent", status: "pending" },
      { id: 3, subject: "Deleted", status: "deleted" },
      { id: 4, subject: "Done", status: "completed" },
    ]);
    expect(visibleSessionTodoRows(state).map(({ task, depth }) => [task.id, depth])).toEqual([
      [1, 0],
      [2, 1],
      [4, 0],
    ]);
    expect(sessionTodoCounts(state)).toEqual({ pending: 1, in_progress: 1, deferred: 0, completed: 1 });
  });

  it("matches the TUI open-panel rule for completed-only snapshots", () => {
    const completed = snapshot([{ id: 1, subject: "Done", status: "completed" }]);
    expect(hasOpenSessionTodos(completed)).toBe(false);
    expect(visibleSessionTodoRows(completed)).toEqual([]);
  });

  it("keeps the newest snapshot for each ACP session", () => {
    const newer = snapshot([{ id: 1, subject: "New", status: "pending" }], 20);
    const older = snapshot([{ id: 1, subject: "Old", status: "pending" }], 10);
    let states = updateSessionTodoSnapshots(new Map(), "acp-1", newer);
    states = updateSessionTodoSnapshots(states, "acp-1", older);
    states = updateSessionTodoSnapshots(states, "acp-2", older);
    expect(states.get("acp-1")?.details.tasks[0]?.subject).toBe("New");
    expect(states.get("acp-2")?.details.tasks[0]?.subject).toBe("Old");
  });
});
