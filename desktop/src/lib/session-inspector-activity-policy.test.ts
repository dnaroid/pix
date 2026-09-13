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

    expect(tracker.observe("session-a", undefined, undefined)).toBeNull();
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

    expect(tracker.observe("session-a", completedOnly, undefined)).toBeNull();
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
    expect(tracker.observe("session-b", undefined, undefined)).toBeNull();
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
});
