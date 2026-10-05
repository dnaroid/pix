import { describe, expect, it, vi } from "vitest";
import {
  buildWorkbenchConversationProps,
  buildWorkbenchEditorProps,
} from "./desktop-workbench-prop-builders";
import { createQuotaWaitStore } from "./quota-wait.svelte";
import { createHeadsUpStore } from "./heads-up.svelte";

function conversationOptions(sessionId: string | null, quotaWait = createQuotaWaitStore({
  client: () => null,
  runtimeReady: () => true,
  reportError: () => {},
})) {
  return {
    transcript: () => [],
    activeSessionId: () => sessionId,
    workspace: () => "/workspace",
    promptRunning: () => false,
    operationRunning: () => false,
    sessionHistoryLoading: () => false,
    promptText: () => "",
    setPromptText: vi.fn(),
    promptAttachments: () => [],
    statusReady: () => true,
    activeSessionRuntimeReady: () => true,
    sessionMutationRunning: () => false,
    dragActive: () => false,
    activeAgentControlState: () => undefined,
    activeSlashCommands: () => [],
    pendingElicitation: () => null,
    questionImageAdding: () => false,
    transcriptScroll: { followsLatest: true, handleScroll: vi.fn(), jumpToLatest: vi.fn() },
    workspaceController: {},
    preview: { active: undefined, canGoBack: false, canGoForward: false, move: vi.fn() },
    transcriptAttachments: { prepare: vi.fn() },
    branchActions: { runUserMessageContextAction: vi.fn() },
    history: { loading: false },
    promptQueue: { deferCurrentDraft: vi.fn(), actionRunning: false, actOnQueuedMessage: vi.fn() },
    promptRuntime: {
      queueItemsBySession: new Map(),
      pauseActiveAgent: vi.fn(),
      continueActiveAgent: vi.fn(),
      cancelActivePrompt: vi.fn(),
    },
    autocomplete: { enabled: false, debounceMs: 0, complete: vi.fn() },
    draft: { active: false, promote: vi.fn() },
    conversationActions: { enhancePromptDraft: vi.fn() },
    openHistoryPicker: vi.fn(),
    promptSubmit: { submit: vi.fn() },
    projectActions: { createTaskFromComposer: vi.fn() },
    attachments: { chooseAttachments: vi.fn(), addPastedAttachments: vi.fn(), removeAttachment: vi.fn() },
    elicitation: {},
    questionImages: {},
    lspOnboarding: { activeSuggestion: () => undefined },
    quotaWait,
    headsUp: createHeadsUpStore({ client: () => null, runtimeReady: () => true, reportError: () => {} }),
  } as any;
}

describe("workbench composer props", () => {
  it("makes owned participant read-only and returns to its explicit orchestrator ID", () => {
    const options = conversationOptions("participant");
    options.brainstormLink = () => ({ runId: "r", slot: 2, parentSessionId: "parent", owned: true });
    options.openBrainstormSession = vi.fn();
    const props = buildWorkbenchConversationProps(options);
    expect(props.composer.ready).toBe(false);
    expect(props.queue.disabled).toBe(true);
    expect(props.transcript.operationRunning).toBe(true);
    props.managedCouncil?.onOpenParent();
    expect(options.openBrainstormSession).toHaveBeenCalledWith("parent");
    props.transcript.onUserMessageAction?.({} as never, "fork");
    expect(options.branchActions.runUserMessageContextAction).not.toHaveBeenCalled();
    options.brainstormLink = () => ({ runId: "r", slot: 2, parentSessionId: "parent", owned: false });
    expect(buildWorkbenchConversationProps(options).composer.ready).toBe(true);
  });
  it("keeps input ready while the selected session runtime and history are opening", () => {
    const options = conversationOptions("opening");
    options.activeSessionRuntimeReady = () => false;
    options.sessionHistoryLoading = () => true;
    expect(buildWorkbenchConversationProps(options).composer.ready).toBe(true);
    options.sessionMutationRunning = () => true;
    expect(buildWorkbenchConversationProps(options).composer.ready).toBe(false);
    options.sessionMutationRunning = () => false;
    options.statusReady = () => false;
    expect(buildWorkbenchConversationProps(options).composer.ready).toBe(false);
  });
  it("opens the quota-wait schedule popup for the active session", () => {
    const quotaWait = createQuotaWaitStore({
      client: () => null,
      runtimeReady: () => true,
      reportError: () => {},
    });
    const props = buildWorkbenchConversationProps(conversationOptions("session-1", quotaWait));
    expect(typeof props.composer.onScheduleContinuation).toBe("function");
    props.composer.onScheduleContinuation?.();
    expect(quotaWait.scheduleVisible("session-1")).toBe(true);
    expect(quotaWait.scheduleVisible("session-2")).toBe(false);
  });

  it("omits schedule continuation without an active session", () => {
    const props = buildWorkbenchConversationProps(conversationOptions(null));
    expect(props.composer.onScheduleContinuation).toBeUndefined();
  });

  it("observer discussion checks live session, dialog and mutation ownership rather than captured props", () => {
    const options = conversationOptions("session-1");
    const now = Date.now();
    options.headsUp.handleSessionState({ sessionId: "session-1", channel: "heads-up", data: {
      version: 1, instanceId: "runtime-1", revision: 1, enabled: true, model: "provider/model", phase: "idle",
      checks: 1, inputTokens: 1, outputTokens: 1,
      notice: { id: "notice-1", title: "Config changed", consequence: "Old format fails", evidence: [{ id: "entry-1", text: "Old schema was removed" }], createdAt: now, expiresAt: now + 30_000 },
    } });
    try {
      const props = buildWorkbenchConversationProps(options);
      expect(props.composer.headsUp).toBeTruthy();
      expect("headsUpControl" in props.composer).toBe(false);
      options.activeSessionId = () => "session-2";
      props.composer.headsUp?.onDiscuss();
      expect(options.setPromptText).not.toHaveBeenCalled();
      options.activeSessionId = () => "session-1";
      options.pendingElicitation = () => ({ kind: "confirmation" });
      props.composer.headsUp?.onDiscuss();
      expect(options.setPromptText).not.toHaveBeenCalled();
      options.pendingElicitation = () => null;
      options.sessionMutationRunning = () => true;
      props.composer.headsUp?.onDiscuss();
      expect(options.setPromptText).not.toHaveBeenCalled();
      options.sessionMutationRunning = () => false;
      props.composer.headsUp?.onDiscuss();
      expect(options.setPromptText).toHaveBeenCalledWith(expect.stringContaining("Please check this observer note"));
      expect(options.promptSubmit.submit).not.toHaveBeenCalled();
    } finally { options.headsUp.reset(); }
  });
  it("routes feedback, discussion and navigation to the selected notice and runtime", async () => {
    const options = conversationOptions("session-1");
    const now = Date.now();
    const a = { id: "notice-a", title: "A", consequence: "A", evidence: [{ id: "entry-a", text: "A" }], createdAt: now, expiresAt: now + 30_000 };
    const b = { ...a, id: "notice-b", title: "B" };
    options.headsUp.handleSessionState({ sessionId: "session-1", channel: "heads-up", data: {
      version: 1, instanceId: "runtime-a", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 1, outputTokens: 1,
      notice: a, notices: [a, b],
    } });
    const props = buildWorkbenchConversationProps(options).composer.headsUp!;
    expect(props.notices).toHaveLength(2);
    const send = vi.spyOn(options.headsUp, "sendFeedback").mockResolvedValue(undefined);
    for (const feedback of ["useful", "incorrect"] as const) {
      props.onFeedback(feedback);
      expect(send).toHaveBeenLastCalledWith("session-1", feedback, "notice-a", "runtime-a");
      const pending = vi.spyOn(options.headsUp, "isPending").mockImplementation((_id, command) => command === `/heads-up ${feedback} notice-a`);
      expect(buildWorkbenchConversationProps(options).composer.headsUp?.pending).toBe(true);
      pending.mockRestore();
    }
    props.onNavigate?.(1);
    expect(options.headsUp.notice("session-1")?.id).toBe("notice-b");
    options.headsUp.handleSessionState({ sessionId: "session-1", channel: "heads-up", data: {
      version: 1, instanceId: "runtime-b", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 1, outputTokens: 1,
      notice: a, notices: [a, b],
    } });
    expect(options.headsUp.notice("session-1")?.id).toBe("notice-a");
    props.onNavigate?.(1);
    expect(options.headsUp.notice("session-1")?.id).toBe("notice-a");
    options.headsUp.reset();
  });
});

describe("workbench Git diff props", () => {
  it("allows workspace review while a UI-only draft has no active session", () => {
    const props = buildWorkbenchEditorProps({
      workspace: () => "/workspace",
      statusReady: () => true,
      clientAvailable: () => true,
      operationRunning: () => false,
      activeWorkbenchTabId: () => "git-diff",
      terminalOpen: () => false,
      externalEditorLabel: () => "Editor",
      preview: { active: null } as any,
      projectDocuments: {} as any,
      projectWorkspace: {} as any,
      git: {
        diffPreview: { scope: "all", content: "+change", truncated: false },
        diffReview: undefined,
        reviewResult: null,
        llmActionId: null,
        resolveRunning: false,
        actionId: null,
      } as any,
      gitAssist: {
        reviewDiff: vi.fn(),
        copyReviewResolutionPrompt: vi.fn(),
        resolveReviewInNewSession: vi.fn(),
      } as any,
      lspOnboarding: { installer: null } as any,
    });

    expect(props.gitDiff?.canReview).toBe(true);
  });

  it("allows editing project and user-config previews but keeps other local previews read-only", async () => {
    const saveUserConfig = vi.fn(async () => true);
    const options = {
      workspace: () => "/workspace",
      statusReady: () => true,
      clientAvailable: () => true,
      operationRunning: () => false,
      activeWorkbenchTabId: () => "preview",
      terminalOpen: () => false,
      externalEditorLabel: () => "Editor",
      preview: {
        active: { id: 1, kind: "file", file: { path: "src/main.ts", content: "x" }, scrollPosition: { left: 0, top: 0 } },
        canGoBack: false,
        canGoForward: false,
        move: vi.fn(),
        validateProjectFile: vi.fn(),
        validateLocalFile: vi.fn(),
        resolveProjectMedia: vi.fn(),
        openProjectFile: vi.fn(),
        openLocalFile: vi.fn(),
        saveUserConfig,
        resolveLocalMedia: vi.fn(),
        rememberScroll: vi.fn(),
        setDirty: vi.fn(),
        close: vi.fn(),
      },
      projectDocuments: { save: vi.fn() },
      projectWorkspace: { openInEditor: vi.fn() },
      git: { diffPreview: null },
      gitAssist: {},
      lspOnboarding: { installer: null },
    } as any;

    expect(buildWorkbenchEditorProps(options).preview?.editable).toBe(true);
    options.preview.active = { ...options.preview.active, file: { path: "~/.config/pi/pix.jsonc", content: "{}" } };
    expect(buildWorkbenchEditorProps(options).preview?.editable).toBe(false);
    options.preview.active = {
      ...options.preview.active,
      userConfigKind: "pi-tools-suite",
      file: { path: "~/.config/pi/pi-tools-suite.jsonc", content: "{}" },
    };
    const settings = buildWorkbenchEditorProps(options).preview;
    expect(settings?.editable).toBe(true);
    await settings?.onSaveProjectFile?.("~/.config/pi/pi-tools-suite.jsonc", "{\n}\n");
    expect(saveUserConfig).toHaveBeenCalledWith(
      "pi-tools-suite",
      "~/.config/pi/pi-tools-suite.jsonc",
      "{\n}\n",
    );
    options.preview.active = { ...options.preview.active, file: { path: "/private/tmp/stdout.txt", content: "output" } };
    delete options.preview.active.userConfigKind;
    const local = buildWorkbenchEditorProps(options).preview;
    expect(local?.editable).toBe(false);
    expect(local?.externalEditorLabel).toBeUndefined();
  });

  it("renders the dedicated terminal workbench surface only while its tab is open", () => {
    const props = buildWorkbenchEditorProps({
      workspace: () => "/workspace",
      statusReady: () => true,
      clientAvailable: () => true,
      operationRunning: () => false,
      activeWorkbenchTabId: () => "terminal",
      terminalOpen: () => true,
      externalEditorLabel: () => "Editor",
      preview: { active: null } as any,
      projectDocuments: {} as any,
      projectWorkspace: {} as any,
      git: { diffPreview: null } as any,
      gitAssist: {} as any,
      lspOnboarding: { installer: null } as any,
    });

    expect(props.terminal).toEqual({ workspace: "/workspace" });
    expect(props.terminalVisible).toBe(true);
  });
});
