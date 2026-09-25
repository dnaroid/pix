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
  it("never opens when todo or live-subagent activity appears", () => {
    const tracker = createSessionInspectorActivityTracker();
    const firstTodo = todos([{ id: 1, subject: "Plan", status: "pending" }]);
    const liveAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }]);

    expect(tracker.observe("session-a", undefined, undefined)).toBe("close");
    expect(tracker.observe("session-a", firstTodo, undefined)).toBeNull();
    expect(tracker.observe("session-a", undefined, liveAgent)).toBeNull();
    expect(tracker.observe("session-a", firstTodo, liveAgent)).toBeNull();
  });

  it("uses visible todo and active-agent filters and closes only when both are empty", () => {
    const tracker = createSessionInspectorActivityTracker();
    const completedOnly = todos([{ id: 1, subject: "Done", status: "completed" }]);
    const pendingTodo = todos([{ id: 2, subject: "Pending", status: "pending" }]);
    const liveAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }]);
    const terminalAgent = subagents([{ runDir: "/run", agents: [{ id: "worker", status: "done" }] }]);

    expect(tracker.observe("session-a", completedOnly, undefined)).toBe("close");
    expect(tracker.observe("session-a", completedOnly, liveAgent)).toBeNull();
    expect(tracker.observe("session-a", pendingTodo, terminalAgent)).toBeNull();
    expect(tracker.observe("session-a", completedOnly, terminalAgent)).toBe("close");
  });

  it("closes an open inspector when activity clears but preserves a closed inspector when activity appears", () => {
    const tracker = createSessionInspectorActivityTracker();
    const activeTodo = todos([{ id: 1, subject: "Active", status: "pending" }]);
    let open = false;
    const setOpen = (next: boolean): void => { open = next; };

    syncSessionInspectorActivity(tracker, "session-a", activeTodo, undefined, open, setOpen);
    expect(open).toBe(false);

    open = true;
    syncSessionInspectorActivity(tracker, "session-a", activeTodo, undefined, open, setOpen);
    expect(open).toBe(true);

    syncSessionInspectorActivity(tracker, "session-a", undefined, undefined, open, setOpen);
    expect(open).toBe(false);
  });

  it("closes a restored or manually opened empty inspector", () => {
    const tracker = createSessionInspectorActivityTracker();
    let open = true;
    const setOpen = (next: boolean): void => { open = next; };

    syncSessionInspectorActivity(tracker, "empty", undefined, undefined, open, setOpen);
    expect(open).toBe(false);
  });
});
