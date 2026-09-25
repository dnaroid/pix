import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { CommandPickerState } from "../lib/command-interactions";
import { appendLocalUserMessage } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createPromptQueueActions } from "./prompt-queue-actions.svelte";
import { createPromptSubmit } from "./prompt-submit";

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
  client: () => AcpClient | null;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  transitions: DesktopSessionTransitionServices;
  prompt: DesktopPromptServices;
  attachments: AttachmentDrafts;
  sessionMutationRunning: () => boolean;
  attachmentDraftKey: () => string;
  promptText: () => string;
  promptAttachments: () => Attachment[];
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  imagePromptSupported: () => boolean;
  focusComposer: () => void | Promise<void>;
  conversation: ConversationActionsRef;
  requestLocalTextInput: (message: string, title: string) => Promise<string | undefined>;
  navigation: ConversationNavigationRef;
  forkConversation: (entryId?: string) => Promise<void>;
  openInteractiveTerminal: (command: string) => void | Promise<void>;
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
    promptRuntime: options.prompt.runtime,
    appendQueuedMessage: options.prompt.queue.appendToTranscript,
    restoreQueuedMessage: options.prompt.queue.restoreToComposer,
    focusComposer: options.focusComposer,
    refreshSessions: options.sessions.catalog.refresh,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  const submit = createPromptSubmit({
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
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    promptRunning: () => options.state.sessionId
      ? options.prompt.runtime.isRunning(options.state.sessionId)
      : false,
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
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: options.transitions.sessionTabs.closeSessionSelector,
    applyModelSlashCommand: options.applyModelSlashCommand,
    applyThinkingSlashCommand: options.applyThinkingSlashCommand,
    setCommandPicker: options.setCommandPicker,
    displayedConfigOptions: options.displayedConfigOptions,
    queueDraftForCurrentRun: queue.queueDraftForCurrentRun,
    imagePromptSupported: options.imagePromptSupported,
    invalidateAttachmentDraft: options.attachments.invalidate,
    nextLocalMessageId: options.nextLocalMessageId,
    appendUserMessage: (text, id, attachments) => {
      const sessionId = options.state.sessionId;
      const previous = options.state.transcript;
      const next = appendLocalUserMessage(previous, text, id, attachments);
      if (sessionId) options.state.setActiveTranscriptForSession(sessionId, next);
      else options.state.setTranscript(next);
      return () => {
        if (options.state.transcript !== next) return;
        options.state.setTranscript(previous);
        if (sessionId && options.state.sessionId === sessionId) {
          options.state.setSessionTranscript(sessionId, previous);
        }
      };
    },
    scrollToLatest: options.scrollToLatest,
    prompts: options.prompt.runtime,
    refreshAutocompleteSettings: options.sessions.autocomplete.refresh,
    refreshSessions: options.sessions.catalog.refresh,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  return { queue, submit };
}

export type DesktopPromptActionServices = ReturnType<typeof createDesktopPromptActionServices>;
