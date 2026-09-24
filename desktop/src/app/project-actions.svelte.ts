import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import {
  projectTaskFromComposerDraft,
  projectTaskPromptDraft,
  type ProjectTask,
  type ProjectTaskDocument,
} from "../lib/project-tasks";
import { buildPromptPayload } from "./prompt-payload";
import { materializeComposerTaskAttachments } from "./attachment-io";

const KNOWLEDGE_REFRESH_PROMPT = [
  "Update the project knowledge documentation to match the current repository.",
  "Use idx context for general behavior/task discovery and idx search for focused code/document lookup. Read the primary sources and verify the actual behavior rather than treating retrieval rankings as proof.",
  "Review each affected primary spec against code and tests; update an existing spec if behavior changed. Only when no current spec covers the behavior, create a focused new spec using .indexer-cli/spec-template.md (ask before setup if the template is missing).",
  "After material changes, run idx audit <changed-paths...> with only the paths changed for this task. Review its document relationships against final code and tests, resolve real semantic drift, and report any remaining gaps; audit candidates alone are not proof of drift.",
  "Do not add or preserve legacy compatibility unless current product requirements explicitly demand it. Treat legacy behavior found in active code/specs as a mismatch to investigate, not as automatically supported behavior.",
].join("\n\n");

type ProjectActionsOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  canUseSession: () => boolean;
  tasksSaving: () => boolean;
  taskLoadFailed: () => boolean;
  taskDocument: () => ProjectTaskDocument;
  saveProjectTasks: (document: ProjectTaskDocument) => Promise<boolean>;
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
  nextLocalMessageId: () => string;
  reportError: (error: unknown) => void;
};

export function createProjectActions(options: ProjectActionsOptions) {
  let actionId = $state<string | null>(null);

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
    });
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

  async function refreshKnowledgeBase(): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || !options.canUseSession()) return;
    const requestWorkspace = options.workspace();
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    let createdSessionId: string | undefined;
    let activated = false;
    try {
      const response = await requestClient.newSession(requestWorkspace);
      createdSessionId = response.sessionId;
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        return;
      }
      await options.ensureRuntime(requestClient, response.sessionId, requestWorkspace);
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        options.forgetRuntime(response.sessionId);
        return;
      }
      if (!options.runtimeReady(response.sessionId)) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        options.forgetRuntime(response.sessionId);
        options.setErrorMessage("Could not start a new session for updating the knowledge base.");
        return;
      }

      options.activateSession(response.sessionId, requestWorkspace, true);
      activated = true;
      options.setOperationRunning(false);
      const transcriptMessageId = options.appendUserMessage(
        response.sessionId,
        KNOWLEDGE_REFRESH_PROMPT,
        [],
      );
      await options.scrollToLatest();
      await options.runPrompt(
        requestClient,
        response.sessionId,
        [{ type: "text", text: KNOWLEDGE_REFRESH_PROMPT }],
        [],
        transcriptMessageId,
      );
      void options.refreshSessions();
    } catch (error) {
      if (createdSessionId && !activated) {
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
        options.forgetRuntime(createdSessionId);
      }
      if (requestClient === options.client() && requestWorkspace === options.workspace()) options.reportError(error);
    } finally {
      if (requestClient === options.client() && requestWorkspace === options.workspace()) {
        options.setOperationRunning(false);
      }
    }
  }

  async function runTask(task: ProjectTask): Promise<void> {
    if (task.sessionId) {
      await openTaskSession(task);
      return;
    }
    const requestClient = options.client();
    if (!requestClient || !options.canUseSession() || options.tasksSaving() || actionId) return;
    const requestWorkspace = options.workspace();
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.setOperationRunning(true);
    actionId = task.id;
    options.setErrorMessage(null);
    try {
      const taskPrompt = projectTaskPromptDraft(task);
      await Promise.all(taskPrompt.attachments.map((attachment) => options.prepareTranscriptAttachment(attachment)));
      const payload = buildPromptPayload(taskPrompt.text, taskPrompt.attachments, options.imagePromptSupported());
      if (options.client() !== requestClient || options.workspace() !== requestWorkspace) return;
      const response = await requestClient.newSession(requestWorkspace);
      if (options.client() !== requestClient || options.workspace() !== requestWorkspace) return;
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
    if (!task.sessionId || actionId || options.sessionMutationRunning()) return;
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
  }

  return {
    get actionId() { return actionId; },
    createTaskFromComposer,
    refreshKnowledgeBase,
    runTask,
    openTaskSession,
    reset,
  };
}
