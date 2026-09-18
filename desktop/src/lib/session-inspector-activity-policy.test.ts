import { describe, expect, it } from "vitest";
import {
  createSessionInspectorActivityTracker,
  syncSessionInspectorActivity,
} from "./session-inspector-activity-policy";
import type { SessionSubagentSnapshot } from "./session-subagents";
import type { SessionTodoSnapshot } from "./session-todos";

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

describe("session inspector activity policy", () => {
  it("opens for first-visible and newly added todo or live-subagent identities", () => {
    const tracker = createSessionInspectorActivityTracker();
    const firstTodo = todos([{ id: 1, subject: "Plan", status: "pending" }]);
    const sameTodoWithChangedStatus = todos([{ id: 1, subject: "Plan", status: "in_progress" }]);
    const liveAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }]);

    expect(tracker.observe("session-a", undefined, undefined)).toBe("close");
    expect(tracker.observe("session-a", firstTodo, undefined)).toBe("open");
    expect(tracker.observe("session-a", sameTodoWithChangedStatus, undefined)).toBeNull();
    expect(tracker.observe("session-a", sameTodoWithChangedStatus, liveAgent)).toBe("open");
    expect(tracker.observe("session-a", sameTodoWithChangedStatus, liveAgent)).toBeNull();
  });

  it("uses the existing visible-list filters and closes only when both lists clear", () => {
    const tracker = createSessionInspectorActivityTracker();
    const completedOnly = todos([{ id: 1, subject: "Done", status: "completed" }]);
    const liveAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }]);
    const terminalAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "done" }] }]);

    expect(tracker.observe("session-a", completedOnly, undefined)).toBe("close");
    expect(tracker.observe("session-a", completedOnly, liveAgent)).toBe("open");
    expect(tracker.observe("session-a", completedOnly, terminalAgent)).toBe("close");
    expect(tracker.observe("session-a", completedOnly, terminalAgent)).toBeNull();
  });

  it("keeps activity history session-scoped so unchanged activity never overrides a manual toggle", () => {
    const tracker = createSessionInspectorActivityTracker();
    const sessionATodo = todos([{ id: 1, subject: "A", status: "pending" }]);
    const sessionBTodo = todos([{ id: 1, subject: "B", status: "pending" }]);

    expect(tracker.observe("session-a", sessionATodo, undefined)).toBe("open");
    // A manual close occurs outside the tracker. An unchanged snapshot must not reopen it.
    expect(tracker.observe("session-a", sessionATodo, undefined)).toBeNull();
    expect(tracker.observe("session-b", undefined, undefined)).toBe("close");
    expect(tracker.observe("session-a", sessionATodo, undefined)).toBeNull();
    expect(tracker.observe("session-b", sessionBTodo, undefined)).toBe("open");
  });

  it("applies only active-session transitions and preserves a manual close for unchanged activity", () => {
    const tracker = createSessionInspectorActivityTracker();
    const sessionATodo = todos([{ id: 1, subject: "A", status: "pending" }]);
    const sessionBTodo = todos([{ id: 2, subject: "B", status: "pending" }]);
    let open = false;
    const setOpen = (next: boolean): void => { open = next; };

    syncSessionInspectorActivity(tracker, "session-a", sessionATodo, undefined, setOpen);
    expect(open).toBe(true);

    open = false;
    syncSessionInspectorActivity(tracker, "session-a", sessionATodo, undefined, setOpen);
    expect(open).toBe(false);

    // A background snapshot is not passed to the active-session effect. It is
    // observed only after that session becomes active.
    syncSessionInspectorActivity(tracker, "session-b", sessionBTodo, undefined, setOpen);
    expect(open).toBe(true);

    syncSessionInspectorActivity(tracker, "session-b", undefined, undefined, setOpen);
    expect(open).toBe(false);
  });

  it("decides each tab's first display from its own current activity", () => {
    const tracker = createSessionInspectorActivityTracker();
    const activeTodo = todos([{ id: 1, subject: "Active", status: "pending" }]);
    let open = true;
    const setOpen = (next: boolean): void => { open = next; };

    // A restored inspector closes when the first tab has no visible activity.
    syncSessionInspectorActivity(tracker, "empty", undefined, undefined, setOpen);
    expect(open).toBe(false);

    // A different tab's already-arrived activity opens on its first display.
    syncSessionInspectorActivity(tracker, "active", activeTodo, undefined, setOpen);
    expect(open).toBe(true);

    // Re-observing either tab is an ordinary update and cannot override a
    // manual choice.
    open = false;
    syncSessionInspectorActivity(tracker, "active", activeTodo, undefined, setOpen);
    expect(open).toBe(false);
  });

  it("opens when first startup activity arrives after an empty first display", () => {
    const tracker = createSessionInspectorActivityTracker();
    const activeTodo = todos([{ id: 1, subject: "Late", status: "pending" }]);

    expect(tracker.observe("session-a", undefined, undefined)).toBe("close");
    expect(tracker.observe("session-a", activeTodo, undefined)).toBe("open");
    // Once shown, unchanged late data respects a subsequent manual close.
    expect(tracker.observe("session-a", activeTodo, undefined)).toBeNull();
  });
});
