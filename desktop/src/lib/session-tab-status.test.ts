import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_ACTIVITY } from "./session-activity";
import { sessionTabStatusKind, sessionTabStatusLabel } from "./session-tab-status";

describe("session tab status", () => {
  it("prioritizes input, warning, paused, running, unseen completion, then idle", () => {
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, retryingSubagents: 1 },
      paused: true,
      running: true,
      needsInput: true,
      unseenComplete: true,
    })).toBe("needs-input");
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, retryingSubagents: 1 },
      paused: true,
      running: true,
      needsInput: false,
      unseenComplete: true,
    })).toBe("warning");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      paused: false,
      running: true,
      needsInput: false,
      unseenComplete: true,
    })).toBe("running");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      paused: false,
      running: false,
      needsInput: false,
      unseenComplete: true,
    })).toBe("unseen-complete");
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      paused: false,
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("idle");
  });

  it("shows paused before the generic running spinner state", () => {
    expect(sessionTabStatusKind({
      activity: EMPTY_SESSION_ACTIVITY,
      paused: true,
      running: true,
      needsInput: false,
      unseenComplete: false,
    })).toBe("paused");
    expect(sessionTabStatusLabel("paused", "Session running")).toBe("Paused");
  });

  it("spins for live subagents, not for a plan item left in progress after execution", () => {
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 1 },
      paused: false,
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("running");
    expect(sessionTabStatusKind({
      activity: { ...EMPTY_SESSION_ACTIVITY, inProgressTodos: 1 },
      paused: false,
      running: false,
      needsInput: false,
      unseenComplete: false,
    })).toBe("idle");
  });

  it("treats blocked plan dependencies as normal rather than warning", () => {
    const options = {
      activity: { ...EMPTY_SESSION_ACTIVITY, blockedTodos: 1 },
      paused: false,
      running: false,
      needsInput: false,
      unseenComplete: false,
    };
    expect(sessionTabStatusKind(options)).toBe("idle");
    expect(sessionTabStatusKind({ ...options, running: true })).toBe("running");
    expect(sessionTabStatusKind({ ...options, paused: true })).toBe("paused");
    expect(sessionTabStatusKind({ ...options, unseenComplete: true })).toBe("unseen-complete");
    expect(sessionTabStatusKind({ ...options, needsInput: true })).toBe("needs-input");
    expect(sessionTabStatusKind({
      ...options,
      activity: { ...options.activity, retryingSubagents: 1 },
    })).toBe("warning");
  });

  it("uses a dedicated label for unseen successful completion", () => {
    expect(sessionTabStatusLabel("unseen-complete", "Session idle")).toBe("Completed · not viewed");
    expect(sessionTabStatusLabel("warning", "1 retrying")).toBe("1 retrying");
  });
});
