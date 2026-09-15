import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_ACTIVITY } from "./session-activity";
import { sessionTabStatusKind, sessionTabStatusLabel } from "./session-tab-status";

describe("session tab status", () => {
  it("prioritizes input, warning, running, unseen completion, then idle", () => {
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, retryingSubagents: 1 },
      running: true,
      needsInput: true,
      unseenComplete: true,
    })).toBe("needs-input");
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, retryingSubagents: 1 },
      running: true,
      needsInput: false,
      unseenComplete: true,
    })).toBe("warning");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      running: true,
      needsInput: false,
      unseenComplete: true,
    })).toBe("running");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      running: false,
      needsInput: false,
      unseenComplete: true,
    })).toBe("unseen-complete");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("idle");
  });

  it("treats live subagents and in-progress plan items as running", () => {
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 1 },
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("running");
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, inProgressTodos: 1 },
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("running");
  });

  it("uses a dedicated label for unseen successful completion", () => {
    expect(sessionTabStatusLabel("unseen-complete", "Session idle")).toBe("Completed · not viewed");
    expect(sessionTabStatusLabel("warning", "1 retrying")).toBe("1 retrying");
  });
});
