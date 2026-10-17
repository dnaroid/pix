import { describe, expect, it, vi } from "vitest";
import { createDesktopPresentationState } from "./desktop-presentation-state.svelte";
import { createDesktopCommandController } from "./desktop-command-controller.svelte";
import { createDraftSession } from "./draft-session.svelte";

describe("new conversations from read-only sub-agent tabs", () => {
  it("keeps creation available while active-session writes remain forbidden", () => {
    let ready = true;
    let workspace = "/project";
    let busy = false;
    const draft = { materializing: false };
    const presentation = createDesktopPresentationState({
      statusReady: () => ready, workspace: () => workspace, operationRunning: () => busy, draft,
      state: { sessionId: "viewer" },
      sessions: { catalog: { sessions: [{ sessionId: "viewer", _meta: {
        "pix.subagent": { runDir: "/run", agentId: "child" },
      } }] } },
    } as never);
    expect(presentation.canCreateSession).toBe(true);
    expect(presentation.canUseSession).toBe(false);
    busy = true;
    expect(presentation.canCreateSession).toBe(false);
    busy = false;
    draft.materializing = true;
    expect(presentation.canCreateSession).toBe(false);
    draft.materializing = false;
    ready = false;
    expect(presentation.canCreateSession).toBe(false);
    ready = true;
    workspace = "";
    expect(presentation.canCreateSession).toBe(false);
  });

  it("enables the new-tab command and opens a draft without touching the child runtime", async () => {
    let sessionId: string | null = "viewer";
    let busy = false;
    const saveActiveTranscript = vi.fn();
    const resetActiveConversation = vi.fn();
    const focusComposer = vi.fn();
    const draft = createDraftSession({
      workspace: () => "/project", statusReady: () => true, operationRunning: () => busy,
      activeSessionId: () => sessionId, setActiveSessionId: (id: string | null) => { sessionId = id; },
      saveActiveTranscript, resetActiveConversation, focusComposer,
      closeProjectSelector: vi.fn(), closeSessionSelector: vi.fn(), cancelHistoryLoad: vi.fn(),
      switchComposerDraft: vi.fn(), resetModelDraft: vi.fn(), draftConfigAvailable: () => true,
    } as never);
    const commands = createDesktopCommandController({
      canUseSession: () => false, statusReady: () => true, workspace: () => "/project",
      sessionMutationRunning: () => busy, closeProjectSelector: vi.fn(),
      closeSessionSelector: vi.fn(), closeModelThinkingPicker: vi.fn(),
      openSessionStartTab: draft.openStartTab,
    } as never);
    busy = true;
    expect(commands.enabled("session.new")).toBe(false);
    await draft.openStartTab();
    expect(sessionId).toBe("viewer");
    busy = false;
    expect(commands.enabled("session.new")).toBe(true);
    await commands.execute("session.new");
    expect(draft.active).toBe(true);
    expect(sessionId).toBeNull();
    expect(saveActiveTranscript).toHaveBeenCalledWith("viewer");
    expect(resetActiveConversation).toHaveBeenCalledOnce();
    expect(focusComposer).toHaveBeenCalledOnce();
  });
});
