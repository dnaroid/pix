import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { appendLocalUserMessage } from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import { createProjectActions } from "./project-actions.svelte";
import type { TaskRunRequest, TaskRunResult } from "../../../acp/src/acp/task-run-contract";

type DesktopProjectActionServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  workspaceOpening?: () => boolean;
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
      const sourceSessionId = options.state.sessionId;
      const sourceOwnerId = options.transitions.draft.active
        ? DRAFT_SESSION_TAB_ID
        : sourceSessionId;
      if (sourceSessionId) options.state.saveActiveTranscript(sourceSessionId);
      options.transitions.draft.deactivate();
      options.transitions.composerDrafts.switchTo(sourceOwnerId, sessionId);
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
    workspaceOpening: options.workspaceOpening,
    planAvailable: (path) => !options.project.documents.removing && options.project.documents.snapshot.plans.includes(path),
    recordPlanLaunch: (workspace, sessionId, path) => options.project.planLaunches.record(workspace, sessionId, path),
    settlePlanLaunch: (sessionId, outcome, workspace) => options.project.planLaunches.settle(sessionId, outcome, workspace),
    nextLocalMessageId: options.nextLocalMessageId,
    reportError: options.reportError,
  });

  async function runTaskFromAgent(request: TaskRunRequest, signal: AbortSignal): Promise<TaskRunResult> {
    const client = options.client();
    const current = () => client && client === options.client() && options.workspace() === request.cwd && !signal.aborted;
    if (!current() || !options.canUseSession() || options.workspaceOpening?.() || actions.actionId
      || options.project.tasks.saving || options.project.tasks.loading) throw new Error("Task launch workspace is unavailable or busy");
    // Agent writes can precede the sidebar's next poll. Launch only the saved row.
    await options.project.tasks.load(request.cwd);
    if (!current() || options.project.tasks.loadFailed) throw new Error("Task launch workspace changed or tasks could not be loaded");
    const task = options.project.tasks.document.tasks.find((candidate) => candidate.id === request.taskId);
    if (!task) throw new Error(`Unknown project task id: ${request.taskId}`);
    return actions.runTaskFromAgent(task, signal);
  }

  return { actions, runTaskFromAgent };
}

export type DesktopProjectActionServices = ReturnType<typeof createDesktopProjectActionServices>;
