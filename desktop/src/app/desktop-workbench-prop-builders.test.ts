import { describe, expect, it, vi } from "vitest";
import {
  buildWorkbenchConversationProps,
  buildWorkbenchEditorProps,
  buildWorkbenchInspectorProps,
} from "./desktop-workbench-prop-builders";
import { createQuotaWaitStore } from "./quota-wait.svelte";

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
  } as any;
}

describe("workbench composer props", () => {
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
});

describe("workbench inspector props", () => {
  function inspectorOptions(sessionId: string | null, open = true) {
    return {
      activeSessionId: () => sessionId,
      activeTitle: () => "Session",
      activeSessionActivity: () => undefined,
      activeTodoSnapshot: () => undefined,
      activeSubagentSnapshot: () => undefined,
      canClearTodos: () => false,
      clearSessionTodos: vi.fn(async () => true),
      inspectorPreference: {
        open,
        setOpen: vi.fn(),
      },
    } as any;
  }

  it("does not render the Session inspector for a UI-only draft", () => {
    expect(buildWorkbenchInspectorProps(inspectorOptions(null)).inspector).toBeNull();
  });

  it("renders the Session inspector for a real active session when preferred open", () => {
    const props = buildWorkbenchInspectorProps(inspectorOptions("session-1"));
    expect(props.inspector?.activeSessionId).toBe("session-1");
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
