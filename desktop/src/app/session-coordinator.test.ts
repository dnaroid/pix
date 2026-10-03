import { describe, expect, it, vi } from "vitest";
import { createSessionCoordinator } from "./session-coordinator";

describe("legacy workspace session state", () => {
  it("does not mutate conversation cwd", () => {
    const activity = vi.fn();
    const unhandled = vi.fn(() => false);
    const coordinator = createSessionCoordinator({
      activity: { handle: activity },
      quotaWait: { handleSessionState: unhandled },
      runtime: { handleSessionState: unhandled },
      registry: { handleSessionState: unhandled },
      lspOnboarding: { handleSessionState: unhandled },
    } as never);

    coordinator.handleState({ sessionId: "conversation-a", channel: "workspace",
      data: { cwd: "/project/next", stack: ["/project"] } });
    coordinator.handleState({ sessionId: "conversation-b", channel: "workspace",
      data: { cwd: "relative", stack: [] } });

    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenCalledWith({ sessionId: "conversation-a", channel: "workspace",
      data: { cwd: "/project/next", stack: ["/project"] } });
  });
});
