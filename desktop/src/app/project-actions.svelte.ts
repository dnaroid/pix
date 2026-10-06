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
import { parseDesktopModelRef } from "./desktop-helpers";

const KNOWLEDGE_REFRESH_PROMPT = [
  "1. Restore the entire project knowledge base to verified clean state, not just Audit paths or one task's audit. Check idx knowledge dirty before review; dirty receipts alone do not prove documentation drift.",
  "2. Use idx context / idx search to locate sources, then review monitored active specs against every declared Implementation/Tests dependency, including unchanged specs. Repair only proven documentation drift; escalate product decisions, not product code/tests/configuration changes. For uncovered behavior use .indexer-cli/spec-template.md; ask before setup if missing. Do not assume legacy behavior is supported without current requirements.",
  "3. Perform all work yourself in this session: source review, documentation repairs, command checks, task audit and final acknowledgment. Do not invoke subagents or spawn/delegate to any agents, including knowledge-auditor, verify or research, even if general workflow instructions require delegation. This service-specific rule prevents concurrent knowledge-base updates and lock conflicts. Run knowledge-base operations sequentially, never in parallel; track dependency coverage, findings and gaps yourself.",
  "4. Store disposable reports/logs in unique directories under the target project's .pi/artifacts/, never root artifacts/ or .artifacts/; retain harness evidence in .pi/subagents/. After documentation changes run idx audit <changed-paths...> for task-changed paths only and check relationships against sources; indexing/audit is not proof of review.",
  "5. Run idx knowledge acknowledge <spec-paths...> yourself only for explicit specs fully reviewed against stable current dependencies with no unresolved drift; acknowledge accurate unchanged specs too. Never acknowledge unreviewed/incomplete/unstable work to clear dirtiness. Concurrent spec/dependency changes invalidate review: re-review stable sources, do not overwrite others' edits or assume unexplained dirtiness is unrelated.",
  "6. Allow at most two review passes total: initial plus one corrective pass only for identified, safe, unblocked gaps. Run idx knowledge dirty after each pass; stop on verified no. Do not poll, repeat unchanged failed commands, launch replacement sessions or delegate cleanup loops to bypass the limit.",
  "7. Escalate immediately and stop for unstable concurrent edits, missing sources, review-blocking failed/unsupported commands or product decisions; also stop if no safe corrective pass exists or dirty remains yes/unknown at the limit. Defer the global cleanup todo, end the turn, and resume only on explicit user instruction; no scheduled retries or waiting for agents.",
  "8. Report global cleanup passed only on a final complete exit-0 idx knowledge dirty result of no; only then complete its todo. Otherwise report blocked, dirty yes/unknown (unknown for failed/incomplete checks), concrete blockers or explicitly unclassified dirtiness, reviewed/acknowledged paths, coverage gaps, command errors/exit codes and next user action. Report task-scoped audit success separately; it cannot override blocked global cleanup.",
].join("\n\n");

type ProjectActionsOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  canUseSession: () => boolean;
  knowledgeReviewModelRef: () => Promise<string | undefined>;
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
      const configuredModel = (await options.knowledgeReviewModelRef())?.trim();
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) return;
      const parsed = configuredModel ? parseDesktopModelRef(configuredModel) : undefined;
      if (configuredModel && !parsed) {
        throw new Error("Knowledge review model must use provider/model[:thinking] format.");
      }
      const response = parsed
        ? await requestClient.newSession(requestWorkspace, {
            modelRef: parsed.modelRef,
            ...(parsed.thinking ? { thinkingLevel: parsed.thinking } : {}),
          })
        : await requestClient.newSession(requestWorkspace);
      createdSessionId = response.sessionId;
      if (requestClient !== options.client() || requestWorkspace !== options.workspace()) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        options.forgetRuntime(response.sessionId);
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
