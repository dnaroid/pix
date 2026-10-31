import { saveWikiSideEdit } from "./wiki-side-edit";
import type { ProjectTaskDraft } from "./project-tasks.svelte";
import { createWikiFindingTask } from "./wiki-finding-task";
import type { WikiFileDates, WikiFileDatesRequest } from "../lib/wiki-file-dates";
import type { ComponentProps } from "svelte";
import type { AcpClient } from "../lib/acp-client";
import DesktopWorkbenchSurface from "../components/DesktopWorkbenchSurface.svelte";
import { isWorkspaceProjectFilePath } from "../lib/project-files";
import { composerActivity } from "../lib/composer-activity";
import type { SubagentSessionLink } from "../lib/session-subagent-link";
import { sessionSubagentRunName } from "../lib/session-subagents";
import type { SubagentSessionNavigation } from "./desktop-subagent-navigation";
import type { PendingElicitation, createElicitationStore } from "./elicitation.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { createAutocompleteStore } from "./autocomplete.svelte";
import type { createConversationBranchActions } from "./conversation-branch-actions";
import type { createConversationSessionActions } from "./conversation-session-actions";
import type { createErrorState } from "./error-state.svelte";
import type { createGitAssist } from "./git-assist";
import type { createKnowledgeResolution } from "./knowledge-resolution.svelte";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { LspOnboardingStore } from "./lsp-onboarding.svelte";
import type { createPreviewStore } from "./preview.svelte";
import type { createProjectActions } from "./project-actions.svelte";
import type { createProjectDocumentsStore } from "./project-documents.svelte";
import type { createProjectWorkspaceStore } from "./project-workspace.svelte";
import type { createPromptQueueActions } from "./prompt-queue-actions.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import type { createPromptSubmit } from "./prompt-submit";
import type { createSessionHandoff } from "./session-handoff.svelte";
import type { createQuestionImageController } from "./question-images";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionTabController } from "./session-tab-controller";
import type { createTranscriptAttachmentController } from "./transcript-attachments";
import type { createTranscriptScrollController } from "./transcript-scroll.svelte";
import type { QuotaWaitStore } from "./quota-wait.svelte";
import type { HeadsUpFeedback, HeadsUpStore } from "./heads-up.svelte";
import type { createWorkspaceController } from "./workspace-controller";
import type { WikiConflictsRecheck } from "./wiki-conflicts-recheck.svelte";
import { resolveWikiFinding, resolveWikiFindings } from "./wiki-finding-resolution";
import { createWikiFindingDecider, type WikiFindingUndoOffer } from "./wiki-finding-decision";
import type { WorkbenchWikiConflictsState } from "./workbench-wiki-conflicts.svelte";

export type DesktopWorkbenchSurfaceViewProps = Omit<
  ComponentProps<typeof DesktopWorkbenchSurface>,
  "transcriptPane" | "transcriptContent" | "promptComposer" | "promptText" | "previewPane" | "terminalPane"
>;

type SessionStartProps = NonNullable<DesktopWorkbenchSurfaceViewProps["sessionStart"]>;

export type WorkbenchShellBuilderOptions = {
  workspace: () => string;
  errorMessage: () => string | null;
  statusError: () => boolean;
  reconnect: () => void | Promise<void>;
  errors: ReturnType<typeof createErrorState>;
  sessionStartOpen: () => boolean;
  sessionStartCandidates: () => SessionStartProps["sessions"];
  searchClient: () => AcpClient | null;
  sessionTabs: ReturnType<typeof createSessionTabController>;
};

export type WorkbenchConversationBuilderOptions = {
  subagentLink?: () => SubagentSessionLink | undefined;
  subagentNavigation?: SubagentSessionNavigation;
  transcript: () => DesktopWorkbenchSurfaceViewProps["transcript"]["transcript"];
  activeSessionId: () => string | null;
  workspace: () => string;
  promptRunning: () => boolean;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  promptText: () => string;
  setPromptText: (text: string) => void;
  promptAttachments: () => DesktopWorkbenchSurfaceViewProps["composer"]["attachments"];
  statusReady: () => boolean;
  activeSessionRuntimeReady: () => boolean;
  sessionMutationRunning: () => boolean;
  dragActive: () => boolean;
  activeAgentControlState: () => DesktopWorkbenchSurfaceViewProps["composer"]["agentControlState"];
  activeSlashCommands: () => DesktopWorkbenchSurfaceViewProps["composer"]["availableCommands"];
  pendingElicitation: () => PendingElicitation | null;
  questionImageAdding: (requestId: number) => boolean;
  transcriptScroll: ReturnType<typeof createTranscriptScrollController>;
  workspaceController: ReturnType<typeof createWorkspaceController>;
  preview: ReturnType<typeof createPreviewStore>;
  transcriptAttachments: ReturnType<typeof createTranscriptAttachmentController>;
  branchActions: ReturnType<typeof createConversationBranchActions>;
  history: ReturnType<typeof createSessionHistory>;
  promptQueue: ReturnType<typeof createPromptQueueActions>;
  promptRuntime: ReturnType<typeof createPromptRuntime>;
  autocomplete: ReturnType<typeof createAutocompleteStore>;
  draft: ReturnType<typeof import("./draft-session.svelte").createDraftSession>;
  conversationActions: ReturnType<typeof createConversationSessionActions>;
  openHistoryPicker: (query: string) => void | Promise<void>;
  promptSubmit: ReturnType<typeof createPromptSubmit>;
  handoff?: ReturnType<typeof createSessionHandoff>;
  projectActions: ReturnType<typeof createProjectActions>;
  attachments: ReturnType<typeof createAttachmentDraftController>;
  elicitation: ReturnType<typeof createElicitationStore>;
  questionImages: ReturnType<typeof createQuestionImageController>;
  lspOnboarding: LspOnboardingStore;
  quotaWait: QuotaWaitStore;
  headsUp: HeadsUpStore;
  openBtw?: (sessionId: string, question?: string) => void | Promise<void>;
  openClaudeLoginTerminal?: (command: string) => Promise<void>;
  reportClaudeLoginError?: (error: unknown) => void;
};

export type WorkbenchEditorBuilderOptions = {
  workspace: () => string;
  /** Live ACP client for whole-document Preview translation. */
  client?: () => AcpClient | null;
  explainFile?: (path: string, content: string, anchor: { left: number; top: number; bottom: number }) => void;
  statusReady: () => boolean;
  clientAvailable: () => boolean;
  operationRunning: () => boolean;
  activeWorkbenchTabId: () => string | null;
  terminalOpen: () => boolean;
  externalEditorLabel: () => string;
  preview: ReturnType<typeof createPreviewStore>;
  projectDocuments: ReturnType<typeof createProjectDocumentsStore>;
  projectWorkspace: ReturnType<typeof createProjectWorkspaceStore>;
  git: ReturnType<typeof createGitWorkspaceStore>;
  gitAssist: ReturnType<typeof createGitAssist>;
  knowledgeResolution?: ReturnType<typeof createKnowledgeResolution>;
  lspOnboarding: LspOnboardingStore;
  wikiConflicts?: {
    state: WorkbenchWikiConflictsState;
    recheck: WikiConflictsRecheck;
    /** Reads a current project file body for comparison; never writes. */
    read: (workspace: string, path: string, signal: AbortSignal) => Promise<string>;
    reportError: (error: unknown) => void;
    /** Git/file timestamps of one comparison side; resolves null on failure. */
    dates?: (workspace: string, request: WikiFileDatesRequest, signal: AbortSignal) => Promise<WikiFileDates | null>;
    /** Creates a compare-and-swap report writer fenced to the current project generation. */
    decisionWriter: () => {
      isCurrent: () => boolean;
      write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
    };
    /** Republishes saved-report findings after a decision write. */
    refresh: () => void;
    /** Logs and shows a failed or partial decision write. */
    reportDecisionError: (error: unknown) => void;
    /** Shows the short-lived undo notification after a successful decision change. */
    offerDecisionUndo?: (offer: WikiFindingUndoOffer) => void;
    /** Fenced compare-and-swap writer for inline edits of a comparison side. */
    editWriter?: () => {
      isCurrent: () => boolean;
      write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
    };
    /** Logs and shows a failed inline edit. */
    reportEditError?: (error: unknown) => void;
    /** Project tasks for the explicit «Create task» action of deferred findings. */
    tasks?: {
      prepare: (workspace: string) => Promise<boolean>;
      newId: () => string;
      create: (draft: ProjectTaskDraft) => Promise<boolean>;
      open: (taskId: string) => void | Promise<void>;
    };
  };
};

export function buildWorkbenchShellProps(
  options: WorkbenchShellBuilderOptions,
): Pick<DesktopWorkbenchSurfaceViewProps, "errorBanner" | "sessionStart"> {
  const errorMessage = options.errorMessage();
  return {
    errorBanner: errorMessage ? {
      message: errorMessage,
      canReconnect: options.statusError(),
      onReconnect: () => void options.reconnect(),
      onDismiss: options.errors.clear,
    } : null,
    sessionStart: options.sessionStartOpen() ? {
      workspace: options.workspace(),
      sessions: options.sessionStartCandidates(),
      searchClient: options.searchClient(),
      onSelect: (selectedSessionId) => void options.sessionTabs.selectSessionFromDraft(selectedSessionId),
    } : null,
  };
}

export function buildWorkbenchConversationProps(
  options: WorkbenchConversationBuilderOptions,
): Pick<DesktopWorkbenchSurfaceViewProps, "transcript" | "queue" | "composer" | "managedSubagent"> {
  const sessionId = options.activeSessionId();
  const subagentLink = sessionId ? options.subagentLink?.() : undefined;
  const subagentNavigation = options.subagentNavigation;
  const handoffBusy = !!sessionId && options.handoff?.busySessionId === sessionId;
  const pending = options.pendingElicitation();
  const transcript = options.transcript();
  const questionMode = pending?.kind === "question"
    ? {
        message: pending.message,
        questions: pending.questions,
        state: pending.state,
        addingImages: options.questionImageAdding(pending.requestId),
        onStateChange: (state: typeof pending.state) =>
          options.elicitation.updateQuestionnaire(options.pendingElicitation(), state, pending.requestId),
        onSubmit: (state: typeof pending.state) => options.elicitation.answerQuestion(state, pending.requestId),
        onCancel: () => options.elicitation.cancel(pending.requestId),
        onChooseImages: (questionId: string) => options.questionImages.chooseQuestionImages(questionId, pending.requestId),
        onPasteImages: (questionId: string, files: readonly File[]) =>
          options.questionImages.addPastedQuestionImages(questionId, files, pending.requestId),
        onOpenImage: options.questionImages.openQuestionImage,
      }
    : undefined;

  return {
    transcript: {
      transcript,
      activeSessionId: sessionId,
      runtimeReady: options.activeSessionRuntimeReady(),
      workspace: options.workspace(),
      promptRunning: options.promptRunning(),
      messageMutationRunning: options.promptRunning() || Boolean(sessionId && options.promptRuntime.queueItemsBySession
        .get(sessionId)?.some((item) => item.source === "auto" || item.source === "deferred")),
      agentControlState: options.activeAgentControlState(),
      operationRunning: options.operationRunning() || handoffBusy,
      historyLoading: options.sessionHistoryLoading(),
      showScrollToBottom: !options.transcriptScroll.followsLatest,
      scrollRestoring: options.transcriptScroll.restoring,
      onScroll: options.transcriptScroll.handleScroll,
      onScrollToBottom: options.transcriptScroll.jumpToLatest,
      onLoadOlderHistory: options.history.loadOlder,
      onChooseWorkspace: () => void options.workspaceController.choose(),
      onOpenAttachment: (attachment) => void options.preview.activateAttachment(attachment),
      onPrepareAttachment: options.transcriptAttachments.prepare,
      onValidateProjectFile: options.preview.validateProjectFile,
      onValidateLocalFile: options.preview.validateLocalFile,
      onOpenProjectFile: (path, range) => options.preview.openProjectFile(path, "replace", range),
      onResolveProjectMedia: options.preview.resolveProjectMedia,
      onOpenLocalFile: options.preview.openLocalFile,
      onResolveLocalMedia: options.preview.resolveLocalMedia,
      onLoadToolResult: (toolCallId) => void options.history.loadDeferredToolResult(toolCallId),
      onOpenSubagentSession: subagentNavigation
        ? (runDir, agentId) => void subagentNavigation.openSubagentSession(runDir, agentId)
        : undefined,
      onUserMessageAction: (message, action) => { void options.branchActions.runUserMessageContextAction(message, action); },
      onOpenClaudeLoginTerminal: options.openClaudeLoginTerminal,
      onClaudeLoginError: options.reportClaudeLoginError,
      onHtmlSandboxSubmit: sessionId
        ? (messageId, payload) => options.promptSubmit.submitHtmlSandbox(sessionId, messageId, payload)
        : undefined,
      onChoiceActionsSubmit: sessionId
        ? (text) => options.promptSubmit.submitChoiceActions(sessionId, text)
        : undefined,
      lspSuggestion: options.lspOnboarding.activeSuggestion(),
      onInstallLsp: sessionId ? () => void options.lspOnboarding.pauseAndInstall(sessionId) : undefined,
      onDismissLsp: sessionId ? () => options.lspOnboarding.dismiss(sessionId) : undefined,
    },
    queue: {
      items: sessionId ? (options.promptRuntime.queueItemsBySession.get(sessionId) ?? []) : [],
      disabled: options.operationRunning() || handoffBusy || options.promptQueue.actionRunning,
      onAction: (item, action) => void options.promptQueue.actOnQueuedMessage(item, action),
    },
    composer: {
      messageEditActive: options.promptSubmit.editActive,
      onCancelMessageEdit: options.promptSubmit.cancelEdit,
      onOpenBtw: sessionId && options.openBtw ? () => options.openBtw!(sessionId) : undefined,
      headsUp: (() => {
        const observerNotice = options.headsUp.notice(sessionId);
        const observerSnapshot = options.headsUp.state(sessionId);
        if (!observerNotice || !observerSnapshot) return null;
        const feedbackCommands = ["known", "irrelevant", "dismiss", "useful", "incorrect"].map((action) => `/heads-up ${action} ${observerNotice.id}`);
        return {
          notice: observerNotice,
          snapshot: observerSnapshot,
          notices: options.headsUp.notices(sessionId),
          onNavigate: (direction: -1 | 1) => options.headsUp.selectNotice(sessionId!, observerNotice.id, direction, observerSnapshot.instanceId),
          pending: feedbackCommands.some((command) => options.headsUp.isPending(sessionId, command)),
          onFeedback: (feedback: HeadsUpFeedback) => {
            void options.headsUp.sendFeedback(sessionId!, feedback, observerNotice.id, observerSnapshot.instanceId);
          },
          onDiscuss: () => {
            options.headsUp.discuss(
              sessionId!,
              observerNotice,
              () => options.activeSessionId() === sessionId && options.pendingElicitation() === null
                && !options.operationRunning()
                && !options.sessionMutationRunning() && options.activeSessionRuntimeReady(),
              options.promptText,
              options.promptAttachments,
              options.setPromptText,
              observerSnapshot.instanceId,
            );
          },
        };
      })(),
      activity: composerActivity(transcript, {
        sessionId,
        running: options.promptRunning(),
        ready: options.statusReady() && options.activeSessionRuntimeReady(),
        historyLoading: options.sessionHistoryLoading(),
        draft: options.draft.active,
        controlState: options.activeAgentControlState() ?? "idle",
        waitingForInput: pending !== null,
      }),
      attachments: options.promptAttachments(),
      availableCommands: options.activeSlashCommands(),
      activeSessionId: sessionId,
      draftSession: options.draft.active,
      ready: options.statusReady()
        && (!handoffBusy || !!questionMode)
        && !options.conversationActions.promptEnhancing
        && !subagentLink
        && !options.sessionMutationRunning()
        && (options.draft.active || sessionId !== null),
      promptRunning: options.promptRunning(),
      promptEnhancing: options.conversationActions.promptEnhancing,
      agentControlState: options.activeAgentControlState(),
      dragActive: options.dragActive(),
      autocompleteEnabled: options.autocomplete.enabled,
      autocompleteDebounceMs: options.autocomplete.debounceMs,
      questionMode,
      onAutocomplete: options.autocomplete.complete,
      onFileMentions: options.autocomplete.fileMentions,
      fileMentionContextKey: options.autocomplete.fileMentionContextKey,
      onDraftChange: options.draft.promote,
      onOpenHistory: () => options.openHistoryPicker(""),
      onEnhance: () => options.conversationActions.enhancePromptDraft(options.promptText()),
      onSubmit: options.promptSubmit.submit,
      onDefer: options.promptQueue.deferCurrentDraft,
      onFork: options.promptSubmit.editActive ? undefined : options.promptQueue.forkCurrentDraft,
      onCreateTask: options.projectActions.createTaskFromComposer,
      onScheduleContinuation: sessionId ? () => options.quotaWait.openSchedule(sessionId) : undefined,
      onHandoff: sessionId && !options.handoff?.busySessionId && options.activeSessionRuntimeReady()
        && options.activeAgentControlState() === "idle" && !options.sessionHistoryLoading()
        && !(options.promptRuntime.queueItemsBySession.get(sessionId)?.length)
        ? options.handoff?.start : undefined,
      onPause: options.promptRuntime.pauseActiveAgent,
      onContinue: options.promptRuntime.continueActiveAgent,
      onCancel: options.promptRuntime.cancelActivePrompt,
      onChooseAttachments: () => {
        options.draft.promote();
        return options.attachments.chooseAttachments();
      },
      onPasteAttachments: (files) => {
        options.draft.promote();
        return options.attachments.addPastedAttachments(files);
      },
      onRemoveAttachment: options.attachments.removeAttachment,
      onOpenAttachment: (attachment) => void options.preview.activateAttachment(attachment),
    },
    managedSubagent: sessionId && subagentLink && subagentNavigation ? {
      sessionId,
      agentId: subagentLink.agentId,
      runName: sessionSubagentRunName(subagentLink.runDir),
      poll: () => subagentNavigation.pollViewer(sessionId),
      onContinue: () => void subagentNavigation.continueSubagentSession(sessionId),
      onOpenParent: subagentLink.parentSessionId
        ? () => void subagentNavigation.openParentSession(subagentLink.parentSessionId!)
        : undefined,
    } : undefined,
  };
}

export function buildWorkbenchEditorProps(
  options: WorkbenchEditorBuilderOptions,
): Pick<
  DesktopWorkbenchSurfaceViewProps,
  "preview" | "previewVisible" | "gitDiff" | "gitDiffVisible" | "lspInstall" | "lspInstallVisible" | "terminal" | "terminalVisible"
  | "wikiConflicts" | "wikiConflictsVisible"
> {
  const activePreview = options.preview.active;
  const previewWorkspace = options.workspace();
  const documentGeneration = options.projectDocuments.generation;
  const userConfigKind = activePreview?.kind === "file" ? activePreview.userConfigKind : undefined;
  const virtualContents = activePreview?.kind === "file" && Boolean(activePreview.file.virtualWikiDirectory);
  const saveProjectFile = userConfigKind
    ? (path: string, content: string) => options.preview.saveUserConfig(userConfigKind, path, content)
    : options.projectDocuments.save;
  const gitDiffPreview = options.git.diffPreview;
  const lspInstaller = options.lspOnboarding.installer;

  return {
    preview: activePreview ? {
      workspace: previewWorkspace,
      previewId: activePreview.id,
      active: options.activeWorkbenchTabId() === "preview",
      scrollPosition: activePreview.scrollPosition,
      file: activePreview.kind === "file" ? activePreview.file : undefined,
      markdownLinkBase: activePreview.kind === "file" ? activePreview.markdownLinkBase : undefined,
      lineRange: activePreview.kind === "file" ? activePreview.lineRange : undefined,
      searchRange: activePreview.kind === "file" ? activePreview.searchRange : undefined,
      evidenceCitation: activePreview.kind === "file" ? activePreview.evidenceCitation : undefined,
      evidenceLanguage: activePreview.kind === "file" ? activePreview.evidenceLanguage : undefined,
      attachment: activePreview.kind === "attachment" ? activePreview.attachment : undefined,
      autoplay: activePreview.kind === "attachment" && activePreview.autoplay === true,
      onAutoplayConsumed: () => options.preview.consumeAutoplay(activePreview.id),
      canGoBack: options.preview.canGoBack,
      canGoForward: options.preview.canGoForward,
      editable: activePreview.kind === "file"
        && !virtualContents
        && (userConfigKind !== undefined || isWorkspaceProjectFilePath(activePreview.file.path)),
      externalEditorLabel: activePreview.kind === "file" && !virtualContents && isWorkspaceProjectFilePath(activePreview.file.path)
        ? options.externalEditorLabel()
        : undefined,
      onBack: () => options.preview.move(-1),
      onForward: () => options.preview.move(1),
      onOpenProjectFile: (path, range) => activePreview.kind === "file" && activePreview.markdownLinkBase === "document"
        ? options.preview.openProjectFile(path, "push", range, false, "document")
        : options.preview.openProjectFile(path, "push", range),
      onValidateProjectFile: options.preview.validateProjectFile,
      onValidateLocalFile: options.preview.validateLocalFile,
      onResolveProjectMedia: options.preview.resolveProjectMedia,
      onOpenLocalFile: (path) => options.preview.openLocalFile(path, "push"),
      onResolveLocalMedia: options.preview.resolveLocalMedia,
      onSaveProjectFile: virtualContents ? undefined : saveProjectFile,
      onCheckKnowledge: userConfigKind || virtualContents ? undefined : options.projectDocuments.checkKnowledge,
      onOpenKnowledgeCitation: (citation, language) => options.preview.openKnowledgeCitation(citation, "push", language),
      onResolveKnowledge: !userConfigKind && !virtualContents && options.knowledgeResolution
        && options.statusReady() && options.clientAvailable() && !options.operationRunning()
        ? (result, content) => {
          if (options.workspace() === previewWorkspace && options.projectDocuments.generation === documentGeneration) {
            return options.knowledgeResolution!.start({ workspace: previewWorkspace, result, content });
          }
        }
        : undefined,
      knowledgeResolving: options.knowledgeResolution?.starting ?? false,
      knowledgeJobs: userConfigKind || virtualContents ? [] : options.projectDocuments.knowledgeJobs,
      onEnqueueKnowledgeCheck: userConfigKind || virtualContents ? undefined : options.projectDocuments.enqueueKnowledgeCheck,
      onCancelKnowledgeCheck: userConfigKind || virtualContents ? undefined : options.projectDocuments.cancelKnowledgeCheck,
      knowledgeCheckEnabled: activePreview.kind === "file" && !userConfigKind && !virtualContents
        && Boolean(options.projectDocuments.wikiPath && activePreview.file.path.startsWith(`${options.projectDocuments.wikiPath}/`)),
      onOpenExternalEditor: activePreview.kind === "file" && !virtualContents && isWorkspaceProjectFilePath(activePreview.file.path)
        ? (path) => void options.projectWorkspace.openInEditor(path)
        : undefined,
      onExplainFile: activePreview.kind === "file" && options.explainFile && options.clientAvailable() ? options.explainFile : undefined,
      onTranslateDocument: activePreview.kind === "file" && options.client && options.clientAvailable() && previewWorkspace
        ? (request, signal, onDelta) => {
          const client = options.client?.();
          if (!client) return Promise.reject(new Error("Pix is not connected to a workspace."));
          return client.translateDocument({ cwd: previewWorkspace, ...request }, signal, onDelta);
        }
        : undefined,
      onScrollPositionChange: options.preview.rememberScroll,
      onDirtyChange: options.preview.setDirty,
      onClose: options.preview.close,
    } : null,
    previewVisible: options.activeWorkbenchTabId() === "preview",
    gitDiff: gitDiffPreview ? {
      diff: gitDiffPreview,
      review: options.git.diffReview,
      reviewStale: options.git.reviewResult?.stale ?? false,
      reviewLoading: options.git.llmActionId?.startsWith("review:") === true,
      resolveLoading: options.git.resolveRunning,
      canReview: Boolean(!gitDiffPreview.commit && options.clientAvailable() && options.workspace() && options.statusReady() && !options.git.actionId && !options.git.llmActionId && !options.git.resolveRunning),
      canResolve: Boolean(options.clientAvailable() && options.workspace() && options.statusReady() && !options.operationRunning() && !options.git.actionId && !options.git.llmActionId && !options.git.reviewResult?.stale),
      onValidateProjectFile: options.preview.validateProjectFile,
      onValidateLocalFile: options.preview.validateLocalFile,
      onOpenProjectFile: (path, range) => void options.preview.openProjectFile(path, "replace", range),
      onOpenLocalFile: (path) => void options.preview.openLocalFile(path),
      onReview: () => void options.gitAssist.reviewDiff(gitDiffPreview.path, gitDiffPreview.scope),
      onCopyPrompt: () => options.gitAssist.copyReviewResolutionPrompt(),
      onResolve: () => void options.gitAssist.resolveReviewInNewSession(),
    } : null,
    gitDiffVisible: options.activeWorkbenchTabId() === "git-diff",
    lspInstall: lspInstaller ? {
      state: lspInstaller,
      onRetry: options.lspOnboarding.retry,
    } : null,
    lspInstallVisible: options.activeWorkbenchTabId() === "lsp-install",
    terminal: options.terminalOpen() ? { workspace: options.workspace() } : null,
    terminalVisible: options.activeWorkbenchTabId() === "terminal",
    ...buildWikiConflictsProps(options),
  };
}

function buildWikiConflictsProps(
  options: WorkbenchEditorBuilderOptions,
): Pick<DesktopWorkbenchSurfaceViewProps, "wikiConflicts" | "wikiConflictsVisible"> {
  const wiki = options.wikiConflicts;
  if (!wiki?.state.open) return { wikiConflicts: null, wikiConflictsVisible: false };
  const workspace = options.workspace();
  const isCurrent = () => options.workspace() === workspace;
  const decider = () => createWikiFindingDecider({
    read: (path, signal) => wiki.read(workspace, path, signal),
    writer: wiki.decisionWriter,
    refresh: wiki.refresh,
    reportError: wiki.reportDecisionError,
    offerUndo: wiki.offerDecisionUndo,
  });
  const tasks = wiki.tasks;
  return {
    wikiConflicts: {
      workspace,
      inbox: wiki.state.inbox,
      read: (path, signal) => wiki.read(workspace, path, signal),
      reportError: wiki.reportError,
      dates: wiki.dates ? (request, signal) => wiki.dates!(workspace, request, signal) : undefined,
      rechecking: wiki.recheck.rechecking,
      onRecheck: wiki.recheck.recheck,
      resolving: options.knowledgeResolution?.starting ?? false,
      onResolve: options.knowledgeResolution && options.statusReady() && options.clientAvailable() && !options.operationRunning()
        ? async (finding) => {
          const resolution = options.knowledgeResolution!;
          try {
            await resolveWikiFinding(finding, {
              workspace,
              read: (path, signal) => wiki.read(workspace, path, signal),
              start: (request) => options.workspace() === workspace ? resolution.start(request) : undefined,
            });
          } catch (error) {
            if (options.workspace() === workspace) wiki.reportError(error);
          }
        }
        : undefined,
      onResolveBasket: options.knowledgeResolution && options.statusReady() && options.clientAvailable() && !options.operationRunning()
        ? async (findings) => {
          const resolution = options.knowledgeResolution!;
          let started = false;
          try {
            const outcome = await resolveWikiFindings(findings, {
              workspace,
              read: (path, signal) => wiki.read(workspace, path, signal),
              start: async (request) => {
                started = options.workspace() === workspace && await resolution.startBatch(request);
              },
            });
            return started && options.workspace() === workspace ? outcome : null;
          } catch (error) {
            if (options.workspace() === workspace) wiki.reportError(error);
            return null;
          }
        }
        : undefined,
      onDecide: (finding, decision) => decider().decide(finding, decision),
      onCreateTask: tasks ? async (finding) => {
        try {
          await createWikiFindingTask(finding, {
            prepare: () => tasks.prepare(workspace),
            newId: tasks.newId,
            create: tasks.create,
            decide: (target, decision) => decider().decide(target, decision),
            open: tasks.open,
            isCurrent,
          });
        } catch (error) {
          if (isCurrent()) wiki.reportDecisionError(error);
        }
      } : undefined,
      onOpenTask: tasks ? (taskId) => tasks.open(taskId) : undefined,
      onEditSide: wiki.editWriter ? async (finding, request) => {
        const writer = wiki.editWriter!();
        try {
          const saved = await saveWikiSideEdit(request, {
            read: (path, signal) => wiki.read(workspace, path, signal),
            write: writer.write,
            isCurrent: writer.isCurrent,
            language: finding.reportLanguage,
          });
          if (saved && writer.isCurrent()) wiki.refresh();
          return saved && writer.isCurrent();
        } catch (error) {
          if (writer.isCurrent()) (wiki.reportEditError ?? wiki.reportDecisionError)(error);
          return false;
        }
      } : undefined,
      onOpenCitation: (citation, language) => options.preview.openKnowledgeCitation(citation, "push", language),
      onOpenProjectFile: (path, range) => options.preview.openProjectFile(path, "push", range, false, "document"),
      onValidateProjectFile: options.preview.validateProjectFile,
      onShowList: wiki.state.showList,
    },
    wikiConflictsVisible: options.activeWorkbenchTabId() === "wiki-conflicts",
  };
}
