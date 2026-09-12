import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { appendLocalUserMessage } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createProjectActions } from "./project-actions.svelte";

type DesktopProjectActionServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  canUseSession: () => boolean;
  sessionMutationRunning: () => boolean;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  transitions: DesktopSessionTransitionServices;
  project: DesktopProjectServices;
  prompt: DesktopPromptServices;
  attachmentDraftKey: () => string;
  attachmentGeneration: () => number;
  waitForAttachmentDraftSettled: (key: string) => Promise<void>;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  invalidateAttachmentDraft: () => void;
  openTasksPanel: (taskId: string) => void | Promise<void>;
  closeProjectSelector: () => void;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  forgetRuntime: (sessionId: string) => void;
  prepareTranscriptAttachment: (attachment: Attachment) => Promise<void>;
  imagePromptSupported: () => boolean;
  nextLocalMessageId: () => string;
  scrollToLatest: () => Promise<void>;
  reportError: (error: unknown) => void;
};

export function createDesktopProjectActionServices(options: DesktopProjectActionServicesOptions) {
  const actions = createProjectActions({
    client: options.client,
    workspace: options.workspace,
    canUseSession: options.canUseSession,
    tasksSaving: () => options.project.tasks.saving,
    taskLoadFailed: () => options.project.tasks.loadFailed,
    taskDocument: () => options.project.tasks.document,
    saveProjectTasks: options.project.tasks.save,
    newProjectTaskId: options.project.tasks.newId,
    attachmentDraftKey: options.attachmentDraftKey,
    attachmentGeneration: options.attachmentGeneration,
    waitForAttachmentDraftSettled: options.waitForAttachmentDraftSettled,
    promptText: options.promptText,
    promptAttachments: options.promptAttachments,
    setPromptText: options.setPromptText,
    activeSessionId: () => options.state.sessionId,
    invalidateAttachmentDraft: options.invalidateAttachmentDraft,
    openTasksPanel: options.openTasksPanel,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: options.transitions.sessionTabs.closeSessionSelector,
    setOperationRunning: options.setOperationRunning,
    setErrorMessage: options.setErrorMessage,
    ensureRuntime: options.sessions.runtime.ensure,
    runtimeReady: options.sessions.runtime.isReady,
    forgetRuntime: options.forgetRuntime,
    activateSession: (sessionId, workspace, runtimeReady) => {
      if (runtimeReady) options.state.saveActiveTranscript();
      options.sessions.catalog.ensureProvisional(sessionId, workspace);
      options.sessions.tabs.show(sessionId);
      options.state.setSessionId(sessionId);
      options.sessions.tabs.rememberActive(workspace, sessionId);
      options.state.initializeActiveConversation(
        sessionId,
        runtimeReady ? (options.sessions.runtime.getConfigOptions(sessionId) ?? []) : [],
        runtimeReady,
      );
    },
    prepareTranscriptAttachment: options.prepareTranscriptAttachment,
    imagePromptSupported: options.imagePromptSupported,
    appendUserMessage: (sessionId, text, attachments) => {
      const id = options.nextLocalMessageId();
      options.state.setActiveTranscriptForSession(
        sessionId,
        appendLocalUserMessage(options.state.transcript, text, id, attachments),
      );
      return id;
    },
    runPrompt: (client, sessionId, blocks, fileImages, transcriptMessageId) =>
      options.prompt.runtime.runPromptRequest(client, sessionId, blocks, fileImages, transcriptMessageId),
    scrollToLatest: options.scrollToLatest,
    refreshSessions: options.sessions.catalog.refresh,
    loadSession: options.transitions.sessionTabs.loadSession,
    sessionMutationRunning: options.sessionMutationRunning,
    nextLocalMessageId: options.nextLocalMessageId,
    reportError: options.reportError,
  });

  return { actions };
}

export type DesktopProjectActionServices = ReturnType<typeof createDesktopProjectActionServices>;
