import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { CommandPickerState } from "../lib/command-interactions";
import { appendLocalUserMessage } from "../lib/transcript";
import type { HtmlSandboxViewport } from "../lib/html-sandbox-layout";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createPromptQueueActions } from "./prompt-queue-actions.svelte";
import { createPromptSubmit } from "./prompt-submit";
import { createEditedMessageSubmit } from "./edited-message-submit";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectFilePreview } from "../lib/project-files";
import { createSessionHandoff } from "./session-handoff.svelte";

type AttachmentDrafts = ReturnType<typeof createAttachmentDraftController>;

type ConversationActionsRef = {
  enhancePromptDraft: (draft: string) => void | Promise<void>;
  importConversationPath: (path: string) => void | Promise<void>;
  chooseImportSession: () => void | Promise<void>;
  resumeConversationPath: (path: string) => void | Promise<void>;
  reloadResources: (options?: { echo?: boolean }) => Promise<void>;
};

type ConversationNavigationRef = {
  openJumpPicker: (query: string) => void | Promise<void>;
  openHistoryPicker: (query: string) => void | Promise<void>;
  showHotkeys: () => void;
};

type DesktopPromptActionServicesOptions = {
  submitMessageEdit?: () => Promise<boolean>;
  messageEditActive?: () => boolean;
  cancelMessageEdit?: () => void;
  client: () => AcpClient | null;
  workspace: () => string;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  transitions: DesktopSessionTransitionServices;
  prompt: DesktopPromptServices;
  attachments: AttachmentDrafts;
  sessionMutationRunning: () => boolean;
  handoffAllowed: () => boolean;
  retargetSessionAnchors: (sourceId: string, targetId: string) => void;
  attachmentDraftKey: () => string;
  promptText: () => string;
  promptAttachments: () => Attachment[];
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  imagePromptSupported: () => boolean;
  htmlSandboxViewport?: () => HtmlSandboxViewport | undefined;
  focusComposer: () => void | Promise<void>;
  conversation: ConversationActionsRef;
  requestLocalTextInput: (message: string, title: string) => Promise<string | undefined>;
  navigation: ConversationNavigationRef;
  forkConversation: (entryId?: string) => Promise<void>;
  openInteractiveTerminal: (command: string) => void | Promise<void>;
  openBtw?: (sessionId: string, question?: string) => void | Promise<void>;
  closeProjectSelector: () => void;
  applyModelSlashCommand: (value: string) => void | Promise<void>;
  applyThinkingSlashCommand: (level: string) => void | Promise<void>;
  setCommandPicker: (picker: CommandPickerState | null) => void;
  displayedConfigOptions: () => readonly SessionConfigOption[];
  nextLocalMessageId: () => string;
  scrollToLatest: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopPromptActionServices(options: DesktopPromptActionServicesOptions) {
  const queue = createPromptQueueActions({
    waitForAttachmentDraftSettled: options.attachments.waitForSettled,
    client: options.client,
    activeSessionId: () => options.state.sessionId,
    promptText: options.promptText,
    promptAttachments: options.promptAttachments,
    setPromptText: options.setPromptText,
    setPromptAttachments: options.setPromptAttachments,
    attachmentDraftKey: options.attachmentDraftKey,
    attachmentGeneration: () => options.attachments.generation,
    invalidateAttachmentDraft: options.attachments.invalidate,
    bumpAttachmentGeneration: options.attachments.bumpGeneration,
    imagePromptSupported: options.imagePromptSupported,
    htmlSandboxViewport: options.htmlSandboxViewport,
    promptRuntime: options.prompt.runtime,
    appendQueuedMessage: options.prompt.queue.appendToTranscript,
    restoreQueuedMessage: options.prompt.queue.restoreToComposer,
    scrollToLatest: options.scrollToLatest,
    focusComposer: options.focusComposer,
    refreshSessions: options.sessions.catalog.refresh,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  const runtimeExtensionCommand = (sessionId: string, text: string): boolean => {
    const name = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
    if (name !== "wait" && name !== "quota-wait") return false;
    const commands = options.sessions.metadata.slashCommandsBySession.get(sessionId) ?? [];
    return commands.some((command) => command.name.toLowerCase() === name
      && command._meta?.["pix.commandSource"] === "extension");
  };

  function appendUserMessage(text: string, id: string, attachments: readonly Attachment[]) {
    const sessionId = options.state.sessionId;
    const previous = options.state.transcript;
    const next = appendLocalUserMessage(previous, text, id, attachments);
    if (sessionId) options.state.setActiveTranscriptForSession(sessionId, next);
    else options.state.setTranscript(next);
    return () => {
      if (options.state.transcript !== next) return;
      options.state.setTranscript(previous);
      if (sessionId && options.state.sessionId === sessionId) options.state.setSessionTranscript(sessionId, previous);
    };
  }

  const submit = createPromptSubmit({
    submitMessageEdit: options.submitMessageEdit,
    messageEditActive: options.messageEditActive,
    cancelMessageEdit: options.cancelMessageEdit,
    client: options.client,
    sessionMutationRunning: options.sessionMutationRunning,
    sessionHistoryLoading: () => options.sessions.history.loading,
    waitForAttachmentDraftSettled: options.attachments.waitForSettled,
    attachmentDraftKey: options.attachmentDraftKey,
    attachmentGeneration: () => options.attachments.generation,
    promptText: options.promptText,
    promptAttachments: options.promptAttachments,
    setPromptText: options.setPromptText,
    activeSessionId: () => options.state.sessionId,
    draftSessionTabActive: () => options.transitions.draft.active,
    beginOptimisticDraftSubmit: options.transitions.draft.beginOptimisticSubmit,
    materializeDraftSession: options.transitions.draft.materialize,
    sessionRuntimeReady: options.sessions.runtime.isReady,
    waitForSessionReady: async (client, sessionId) => {
      const workspace = options.workspace();
      const ready = options.sessions.runtime.ensure(client, sessionId, workspace);
      const ownsRuntime = options.sessions.runtime.captureOwnership(sessionId);
      await Promise.all([ready, options.sessions.history.waitForHydration(sessionId)]);
      return client === options.client() && workspace === options.workspace()
        && ownsRuntime() && options.sessions.runtime.isReady(sessionId);
    },
    promptRunning: options.prompt.runtime.isRunning,
    openSessionStartTab: options.transitions.draft.openStartTab,
    enhancePromptDraft: options.conversation.enhancePromptDraft,
    importConversationPath: options.conversation.importConversationPath,
    chooseImportSession: options.conversation.chooseImportSession,
    requestLocalTextInput: options.requestLocalTextInput,
    deferDraft: queue.deferDraft,
    resumeConversationPath: options.conversation.resumeConversationPath,
    openSessionSelector: options.transitions.sessionTabs.openSessionSelector,
    openJumpPicker: options.navigation.openJumpPicker,
    openHistoryPicker: options.navigation.openHistoryPicker,
    showDesktopHotkeys: options.navigation.showHotkeys,
    reloadResources: options.conversation.reloadResources,
    forkConversation: options.forkConversation,
    openInteractiveTerminal: options.openInteractiveTerminal,
    openBtw: options.openBtw,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: options.transitions.sessionTabs.closeSessionSelector,
    applyModelSlashCommand: options.applyModelSlashCommand,
    applyThinkingSlashCommand: options.applyThinkingSlashCommand,
    setCommandPicker: options.setCommandPicker,
    displayedConfigOptions: options.displayedConfigOptions,
    runtimeExtensionCommand,
    queueDraftForCurrentRun: queue.queueDraftForCurrentRun,
    imagePromptSupported: options.imagePromptSupported,
    htmlSandboxViewport: options.htmlSandboxViewport,
    invalidateAttachmentDraft: options.attachments.invalidate,
    nextLocalMessageId: options.nextLocalMessageId,
    appendUserMessage,
    scrollToLatest: options.scrollToLatest,
    prompts: options.prompt.runtime,
    refreshAutocompleteSettings: options.sessions.autocomplete.refresh,
    refreshSessions: options.sessions.catalog.refresh,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  const prepareEditedMessage = createEditedMessageSubmit({
    client: options.client,
    sessionId: () => options.state.sessionId,
    prompts: options.prompt.runtime,
    imagePromptSupported: options.imagePromptSupported,
    nextLocalMessageId: options.nextLocalMessageId,
    appendUserMessage,
    scrollToLatest: options.scrollToLatest,
    refreshSessions: options.sessions.catalog.refresh,
    reportError: options.reportError,
  });

  const handoff = createSessionHandoff({
    client: options.client,
    workspace: options.workspace,
    sessionId: () => options.state.sessionId,
    canStart: () => options.handoffAllowed() && !options.sessionMutationRunning()
      && !options.sessions.history.loading && !submit.editActive
      && !!options.state.sessionId && options.sessions.runtime.isReady(options.state.sessionId)
      && !options.prompt.runtime.isRunning(options.state.sessionId)
      && options.prompt.runtime.agentState(options.state.sessionId) === "idle"
      && !(options.prompt.runtime.queueItemsBySession.get(options.state.sessionId)?.length),
    captureOwnership: () => {
      const historyGeneration = options.sessions.history.generation;
      const ownsRuntime = options.sessions.runtime.captureOwnership(options.state.sessionId!);
      return () => ownsRuntime() && historyGeneration === options.sessions.history.generation;
    },
    isIdle: (sessionId) => !options.prompt.runtime.isRunning(sessionId)
      && options.prompt.runtime.agentState(sessionId) === "idle"
      && !(options.prompt.runtime.queueItemsBySession.get(sessionId)?.length),
    holdAutoQueue: options.prompt.runtime.holdAutoQueue,
    runPrompt: (client, sessionId, text) => {
      const id = options.nextLocalMessageId();
      appendUserMessage(text, id, []);
      void options.scrollToLatest();
      return options.prompt.runtime.runPromptRequestWithResult(client, sessionId,
        [{ type: "text", text }], id);
    },
    readHandoff: async (workspace, path) => {
      const result = await invoke<{ kind: "text"; file: ProjectFilePreview } | { kind: "external" }>(
        "read_preview_file", { workspace, path },
      );
      if (result.kind !== "text") throw new Error(`Handoff file cannot be read: ${path}. The current session was kept.`);
      return result.file.content;
    },
    commitSession: (sourceId, newId, config) => {
      options.state.saveActiveTranscript(sourceId);
      options.transitions.composerDrafts.switchTo(sourceId, newId);
      options.state.setSessionId(newId);
      options.state.initializeActiveConversation(newId, config, true);
      options.sessions.runtime.markReady(newId, config);
      // The fresh session has no history to hydrate; retire prior requests
      // without leaving the live composer in a history-loading state.
      options.sessions.history.cancel();
      options.sessions.history.markFullyLoaded(newId);
      options.sessions.catalog.ensureProvisional(newId, options.workspace());
      options.sessions.tabs.replace(sourceId, newId);
      options.sessions.tabs.rememberActive(options.workspace(), newId);
      options.retargetSessionAnchors(sourceId, newId);
      void options.sessions.catalog.refresh();
    },
    discardSession: options.sessions.runtime.forget,
    reportError: options.reportError,
  });

  return { queue, submit, prepareEditedMessage, handoff };
}

export type DesktopPromptActionServices = ReturnType<typeof createDesktopPromptActionServices>;
