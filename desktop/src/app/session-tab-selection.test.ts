import { describe, expect, it, vi } from "vitest";
import { createSessionTabSelection } from "./session-tab-selection";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";

function fixture(overrides: Partial<SessionTabControllerOptions> = {}) {
  const state = {
    sessionId: "participant",
    transcript: { items: [] },
    setSessionId: vi.fn((id: string) => { state.sessionId = id; }),
    setSessionTranscript: vi.fn(),
    sessionTranscript: vi.fn(() => ({ items: [] })),
    setTranscript: vi.fn(),
    setConfigOptions: vi.fn(),
    setRuntimeReady: vi.fn(),
  };
  const client = { closeSession: vi.fn() };
  const options = {
    client: () => client,
    workspace: () => "/work",
    statusReady: () => true,
    operationRunning: () => false,
    // The active participant is read-only, not unnavigable.
    canUseSession: () => false,
    state,
    draft: { active: false, materializing: false, deactivate: vi.fn() },
    closeProjectSelector: vi.fn(),
    tabs: { closeSelector: vi.fn(), show: vi.fn(), rememberActive: vi.fn() },
    catalog: { sessions: [] },
    setErrorMessage: vi.fn(),
    switchComposerDraft: vi.fn(),
    history: { cancel: vi.fn(), needsHydration: vi.fn(() => false) },
    runtime: {
      getConfigOptions: vi.fn(() => []),
      isReady: vi.fn(() => true),
      ensure: vi.fn(async () => {}),
      schedulePrewarm: vi.fn(),
    },
    tabSessionIds: () => ["participant", "orchestrator"],
    ...overrides,
  };
  const selection = createSessionTabSelection(options as unknown as SessionTabControllerOptions);
  return { state, client, options, selection };
}

describe("session tab navigation from a managed council participant", () => {
  it("opens a sub-agent viewer next to its recorded parent, not the active conversation", async () => {
    const { selection, options } = fixture({
      catalog: { sessions: [{ sessionId: "child", cwd: "/work", _meta: {
        "pix.subagent": { runDir: "/run", agentId: "worker", parentSessionId: "parent" },
      } }] } as unknown as SessionTabControllerOptions["catalog"],
    });
    await selection.loadSession("child");
    expect(options.tabs.show).toHaveBeenCalledWith("child", "parent");
  });

  it("allows returning to the orchestrator without closing or mutating the participant", async () => {
    const { selection, state, client, options } = fixture();
    await selection.loadSession("orchestrator");
    expect(state.sessionId).toBe("orchestrator");
    expect(options.tabs.show).toHaveBeenCalledWith("orchestrator");
    expect(options.switchComposerDraft).toHaveBeenCalledWith("participant", "orchestrator");
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(options.runtime.ensure).toHaveBeenCalledWith(client, "orchestrator", "/work");
  });

  it("allows tab clicks to select another participant while source writes are locked", () => {
    const { selection, state } = fixture();
    selection.handleSessionTabClick("other-participant");
    expect(state.sessionId).toBe("other-participant");
  });

  it.each([
    { statusReady: () => false },
    { workspace: () => "" },
    { operationRunning: () => true },
    { client: () => null },
  ])("still blocks navigation when the workspace connection is unavailable or transitioning (%j)", async (overrides) => {
    const { selection, state, options } = fixture(overrides);
    await selection.loadSession("orchestrator");
    expect(state.sessionId).toBe("participant");
    expect(options.runtime.ensure).not.toHaveBeenCalled();
  });
});
