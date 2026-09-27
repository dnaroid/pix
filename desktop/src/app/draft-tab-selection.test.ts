import { describe, expect, it, vi } from "vitest";
import { createDraftSession, DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import { createSessionTabSelection } from "./session-tab-selection";
import { createWorkbenchController } from "./workbench-controller";
import { workbenchSessionTabId } from "../lib/workbench-tabs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("selecting an existing tab during draft materialization", () => {
  it("lets an optimistic draft materialize in the background without stealing selection", async () => {
    const created = deferred<{ sessionId: string }>();
    const closed: string[] = [];
    let current: string | null = null;
    const prompt = "keep this prompt";
    const optimisticTranscript = { items: [] } as never;
    const clearPrompt = vi.fn();
    const invalidateAttachmentDraft = vi.fn();
    const switchComposerDraft = vi.fn();
    const storeComposerDraft = vi.fn();
    const forgetComposerDraft = vi.fn();
    const setPromptText = vi.fn();
    const replacePromptAttachments = vi.fn();
    const setActiveTranscript = vi.fn();
    const showSessionTab = vi.fn();
    const retargetAttachmentDraftKey = vi.fn();
    const adoptMaterializedTranscript = vi.fn();
    const setConfigOptions = vi.fn();
    const markRuntimeReady = vi.fn();
    const rememberActiveSession = vi.fn();
    let draft!: ReturnType<typeof createDraftSession>;
    draft = createDraftSession({
      client: () => client as never, workspace: () => "/work", statusReady: () => true,
      operationRunning: () => false, canUseSession: () => false,
      activeSessionId: () => current, setActiveSessionId: (id) => { current = id; },
      saveActiveTranscript: vi.fn(), resetActiveConversation: vi.fn(), closeProjectSelector: vi.fn(),
      closeSessionSelector: vi.fn(), cancelHistoryLoad: vi.fn(), resetModelDraft: vi.fn(),
      draftConfigAvailable: () => true, refreshDraftConfig: vi.fn(), draftModelOverride: () => null,
      routeDraftModel: vi.fn(async () => null),
      switchComposerDraft, storeComposerDraft, forgetComposerDraft,
      setPromptText, replacePromptAttachments,
      activeTranscript: () => optimisticTranscript, setActiveTranscript,
      focusComposer: vi.fn(), forgetRuntime: vi.fn(), ensureProvisionalSession: vi.fn(), showSessionTab,
      retargetWorkbenchAnchors: vi.fn(), retargetAttachmentDraftKey, adoptMaterializedTranscript,
      setConfigOptions, markRuntimeReady, rememberActiveSession,
      setErrorMessage: vi.fn(), reportError: vi.fn(),
    });
    const client = {
      newSession: vi.fn(() => created.promise),
      loadSession: vi.fn(async () => ({})),
      closeSession: vi.fn(async (id: string) => { closed.push(id); }),
    };
    draft.activate();
    expect(draft.beginOptimisticSubmit(prompt, [])).toBe(true);
    const submission = draft.materialize(prompt, 1);
    await Promise.resolve();
    expect(draft.materializing).toBe(true);
    const tabs = { closeSelector: vi.fn(), show: vi.fn(), rememberActive: vi.fn() };
    const selection = createSessionTabSelection({
      client: () => client as never, workspace: () => "/work", statusReady: () => true,
      canUseSession: () => !draft.materializing, sessionMutationRunning: () => draft.materializing,
      state: { sessionId: null, transcript: [], setSessionId: (id: string) => { current = id; },
        setSessionTranscript: vi.fn(), sessionTranscript: () => undefined, setTranscript: vi.fn(),
        setConfigOptions: vi.fn(), setRuntimeReady: vi.fn() },
      operationRunning: () => false, setOperationRunning: vi.fn(), promptRunning: () => false,
      catalog: { refresh: vi.fn() }, tabs, draft,
      runtime: { getConfigOptions: () => [], isReady: () => false, ensure: vi.fn(async () => {}), schedulePrewarm: vi.fn(), invalidatePrewarm: vi.fn() },
      history: { cancel: vi.fn(), begin: vi.fn(() => 1), hydrate: vi.fn() },
      closeProjectSelector: vi.fn(), clearSessionActivity: vi.fn(), resetSessionActivity: vi.fn(), forgetRuntime: vi.fn(),
      retargetWorkbenchAnchors: vi.fn(), clearPrompt, invalidateAttachmentDraft,
      switchComposerDraft, forgetComposerDraft, resetComposerDrafts: vi.fn(),
      tabSessionIds: () => [], focusComposer: vi.fn(), refreshQueueState: vi.fn(),
      setErrorMessage: vi.fn(), reportError: vi.fn(),
    } as never);

    const controller = createWorkbenchController({
      tabs: () => [{ id: workbenchSessionTabId("existing"), kind: "session", sessionId: "existing",
        label: "Existing", title: "Existing", panelId: "conversation", closable: true, disabled: true,
        selectionDisabled: false, running: false, draft: false, fork: false, statusKind: "idle" }],
      activeTabId: () => null, activeConversationTabId: () => null,
      setActiveTabId: vi.fn(), handleSessionTabClick: (id) => { void selection.loadSession(id); },
      closeSessionTab: vi.fn(async () => true), previewPane: () => null, closePreview: vi.fn(),
      closeGitDiff: vi.fn(), closeLspInstall: vi.fn(), closeTerminal: vi.fn(),
      retargetPreviewAnchor: vi.fn(), retargetGitAnchor: vi.fn(),
    });
    controller.select(workbenchSessionTabId("existing"));
    expect(current).toBe("existing");
    expect(draft.active).toBe(false);
    expect(draft.open).toBe(true);
    expect(clearPrompt).not.toHaveBeenCalled();
    expect(invalidateAttachmentDraft).not.toHaveBeenCalled();
    expect(setPromptText).not.toHaveBeenCalled();
    expect(replacePromptAttachments).not.toHaveBeenCalled();
    expect(switchComposerDraft).toHaveBeenCalledWith(DRAFT_SESSION_TAB_ID, "existing");
    created.resolve({ sessionId: "background" });
    await expect(submission).resolves.toBe("background");
    expect(current).toBe("existing");
    expect(closed).toEqual([]);
    expect(client.loadSession).toHaveBeenCalledWith("background", "/work");
    expect(showSessionTab).toHaveBeenCalledWith("background");
    expect(adoptMaterializedTranscript).toHaveBeenCalledWith("background", optimisticTranscript);
    expect(markRuntimeReady).toHaveBeenCalledWith("background", []);
    expect(retargetAttachmentDraftKey).not.toHaveBeenCalled();
    expect(setConfigOptions).not.toHaveBeenCalled();
    expect(rememberActiveSession).not.toHaveBeenCalled();
    expect(draft.open).toBe(false);
    expect(draft.materializing).toBe(false);
  });
});
