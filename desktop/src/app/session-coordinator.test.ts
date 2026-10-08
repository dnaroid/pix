import { describe, expect, it, vi } from "vitest";
import { createSessionCoordinator } from "./session-coordinator";
import { createSessionActivityStore } from "./session-activity.svelte";
import { createSessionUpdateBatcher } from "./session-update-batcher";
import { createActiveSessionState } from "./active-session-state.svelte";

describe("legacy workspace session state", () => {
  it("drops retired-session updates until a fresh attachment opens", () => {
    const state = createActiveSessionState();
    const activity = createSessionActivityStore();
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frame.mockImplementation(callback); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const updates = createSessionUpdateBatcher({ state, promptEndedAt: () => undefined,
      promptRunning: () => false, clearPromptEndedAt: vi.fn(), followsLatest: () => false, scheduleScrollToLatest: vi.fn() });
    const coordinator = createSessionCoordinator({ activity, updates, metadata: { handle: () => false } } as never);
    const notification = { sessionId: "closing", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "late" } } } as const;
    try {
      activity.open("closing");
      coordinator.handleUpdate(notification);
      activity.markForgotten("closing");
      updates.discardSession("closing");
      coordinator.handleUpdate(notification);
      state.deleteSessionTranscript("closing");
      coordinator.handleUpdate(notification);
      frame();
      expect(state.sessionTranscript("closing")).toBeUndefined();
      activity.open("closing");
      coordinator.handleUpdate(notification);
      frame();
      expect(state.sessionTranscript("closing")?.items).toHaveLength(1);
    } finally {
      updates.dispose();
      vi.unstubAllGlobals();
    }
  });

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
