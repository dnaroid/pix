import type { AcpClient } from "../lib/acp-client";
import { invoke } from "@tauri-apps/api/core";
import { attachmentFromFile, type Attachment, type AttachmentFile } from "../lib/attachments";
import {
  projectTaskFromComposerDraft,
  projectTaskPromptDraft,
  type ProjectTask,
  type ProjectTaskDocument,
} from "../lib/project-tasks";
import { buildPromptPayload } from "./prompt-payload";
import { materializeComposerTaskAttachments } from "./attachment-io";
import { parseDesktopModelRef } from "./desktop-helpers";
import { createProjectPlanActions } from "./project-plan-actions.svelte";

export type ProjectActionsOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  canUseSession: () => boolean;
  tasksSaving: () => boolean;
  taskLoadFailed: () => boolean;
  taskDocument: () => ProjectTaskDocument;
  saveProjectTasks: (document: ProjectTaskDocument, attachments?: readonly Attachment[]) => Promise<boolean>;
  newProjectTaskId: () => string;
  attachmentDraftKey: () => string;
  attachmentGeneration: () => number;
  waitForAttachmentDraftSettled: (key: string) => Promise<void>;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  activeSessionId: () => string | null;
  invalidateAttachmentDraft: () => void;
  openTasksPanel: (taskId: string) => void | Promise<void>;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  ensureRuntime: (client: AcpClient, sessionId: string, workspace: string) => Promise<void>;
  runtimeReady: (sessionId: string) => boolean;
  forgetRuntime: (sessionId: string) => void;
  activateSession: (sessionId: string, workspace: string, runtimeReady: boolean) => void;
  prepareTranscriptAttachment: (attachment: Attachment) => Promise<void>;
  taskAttachments?: (workspace: string, taskId: string) => Promise<AttachmentFile[]>;
  imagePromptSupported: () => boolean;
  appendUserMessage: (sessionId: string, text: string, attachments: readonly Attachment[]) => string;
  runPrompt: (
    client: AcpClient,
    sessionId: string,
    blocks: ReturnType<typeof buildPromptPayload>["blocks"],
    fileImages: ReturnType<typeof buildPromptPayload>["fileImages"],
    transcriptMessageId: string,
  ) => Promise<void>;
  scrollToLatest: () => Promise<void>;
  refreshSessions: () => void | Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  sessionMutationRunning: () => boolean;
  planAvailable?: (path: string) => boolean;
  nextLocalMessageId: () => string;
  reportError: (error: unknown) => void;
};

export function createProjectActions(options: ProjectActionsOptions) {
  let actionId = $state<string | null>(null);
  const plans = createProjectPlanActions(options, () => actionId !== null);

  async function createTaskFromComposer(): Promise<void> {
    if (!options.workspace() || options.tasksSaving() || options.taskLoadFailed()) return;
    const initialDraftKey = options.attachmentDraftKey();
    await options.waitForAttachmentDraftSettled(initialDraftKey);
    if (
      initialDraftKey !== options.attachmentDraftKey()
      || !options.workspace()
      || options.tasksSaving()
      || options.taskLoadFailed()
    ) return;

    const requestWorkspace = options.workspace();
    const requestClient = options.client();
    const requestSessionId = options.activeSessionId();
    const draftKey = options.attachmentDraftKey();
    const draftGeneration = options.attachmentGeneration();
    const text = options.promptText();
    const attachments = options.promptAttachments();
    let storedAttachments: Attachment[];
    try {
      storedAttachments = await materializeComposerTaskAttachments(
        attachments,
        requestWorkspace,
        requestClient,
        requestSessionId,
      );
    } catch (error) {
      options.reportError(error);
      return;
    }
    if (options.workspace() !== requestWorkspace || options.tasksSaving() || options.taskLoadFailed()) return;
    const timestamp = new Date().toISOString();
    const task = projectTaskFromComposerDraft(text, storedAttachments, options.newProjectTaskId(), timestamp);
    if (!task) return;

    const saved = await options.saveProjectTasks({
      ...options.taskDocument(),
      tasks: [task, ...options.taskDocument().tasks],
    }, storedAttachments);
    if (!saved || options.workspace() !== requestWorkspace) return;
    await options.openTasksPanel(task.id);

    if (
      options.activeSessionId() === requestSessionId
      && options.attachmentDraftKey() === draftKey
      && options.attachmentGeneration() === draftGeneration
      && options.promptText() === text
      && options.promptAttachments() === attachments
    ) {
      options.setPromptText("");
      options.invalidateAttachmentDraft();
    }
  }

  async function runTask(task: ProjectTask): Promise<void> {
    if (task.sessionId) {
      await openTaskSession(task);
      return;
    }
    const requestClient = options.client();
    if (!requestClient || !options.canUseSession() || options.tasksSaving() || actionId || plans.actionId) return;
    const requestWorkspace = options.workspace();
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    actionId = task.id;
    options.setErrorMessage(null);
    try {
      const basePrompt = projectTaskPromptDraft(task);
      const taskFiles = await (options.taskAttachments
        ? options.taskAttachments(requestWorkspace, task.id)
        : invoke<AttachmentFile[]>("read_project_task_attachments", { workspace: requestWorkspace, id: task.id }));
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) return;
      const taskPrompt = {
        ...basePrompt,
        attachments: [
          ...basePrompt.attachments,
          ...taskFiles.map((file, index) => attachmentFromFile(file, `task:${task.id}:sqlite:${index}`)),
        ],
      };
      await Promise.all(taskPrompt.attachments.map((attachment) => options.prepareTranscriptAttachment(attachment)));
      const payload = buildPromptPayload(taskPrompt.text, taskPrompt.attachments, options.imagePromptSupported());
      if (options.client() !== requestClient || options.workspace() !== requestWorkspace) return;
      const chosenModel = task.modelRef ? parseDesktopModelRef(task.modelRef) : undefined;
      if (task.modelRef && !chosenModel) throw new Error("Assigned task model must use provider/model[:thinking] format.");
      const response = chosenModel
        ? await requestClient.newSession(requestWorkspace, {
            modelRef: chosenModel.modelRef,
            ...(chosenModel.thinking ? { thinkingLevel: chosenModel.thinking } : {}),
          })
        : await requestClient.newSession(requestWorkspace);
      if (options.client() !== requestClient || options.workspace() !== requestWorkspace) {
        options.forgetRuntime(response.sessionId);
        void requestClient.closeSession(response.sessionId).catch(() => undefined);
        return;
      }
      options.activateSession(response.sessionId, requestWorkspace, false);
      await options.ensureRuntime(requestClient, response.sessionId, requestWorkspace);
      if (!options.runtimeReady(response.sessionId)) return;
      void options.refreshSessions();

      const timestamp = new Date().toISOString();
      const document = options.taskDocument();
      const saved = await options.saveProjectTasks({
        ...document,
        tasks: document.tasks.map((candidate) => candidate.id === task.id
          ? {
              ...candidate,
              status: candidate.status === "done" ? "done" : "in-progress",
              sessionId: response.sessionId,
              updatedAt: timestamp,
            }
          : candidate),
      });
      if (!saved || options.client() !== requestClient || options.workspace() !== requestWorkspace) return;

      options.setOperationRunning(false);
      const transcriptMessageId = options.appendUserMessage(
        response.sessionId,
        taskPrompt.text,
        taskPrompt.attachments,
      );
      await options.scrollToLatest();
      await options.runPrompt(
        requestClient,
        response.sessionId,
        payload.blocks,
        payload.fileImages,
        transcriptMessageId,
      );
      void options.refreshSessions();
    } catch (error) {
      options.reportError(error);
    } finally {
      if (options.workspace() === requestWorkspace) {
        options.setOperationRunning(false);
        actionId = null;
      }
    }
  }

  async function openTaskSession(task: ProjectTask): Promise<void> {
    if (!task.sessionId || actionId || plans.actionId || options.sessionMutationRunning()) return;
    if (task.sessionId === options.activeSessionId()) return;
    actionId = task.id;
    try {
      await options.loadSession(task.sessionId);
    } finally {
      actionId = null;
    }
  }

  function reset(): void {
    actionId = null;
    plans.reset();
  }

  return {
    get actionId() { return actionId ?? plans.actionId; },
    runPlan: plans.runPlan,
    createTaskFromComposer,
    runTask,
    openTaskSession,
    reset,
  };
}
