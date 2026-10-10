import type { ComponentProps } from "svelte";
import type { AcpClient } from "../lib/acp-client";
import DesktopWorkbenchSurface from "../components/DesktopWorkbenchSurface.svelte";
import { isWorkspaceProjectFilePath } from "../lib/project-files";
import { composerActivity } from "../lib/composer-activity";
import type { BrainstormSessionLink } from "../lib/session-brainstorm";
import type { PendingElicitation, createElicitationStore } from "./elicitation.svelte";
import type { createAttachmentDraftController } from "./attachment-drafts";
import type { createAutocompleteStore } from "./autocomplete.svelte";
import type { createConversationBranchActions } from "./conversation-branch-actions";
import type { createConversationSessionActions } from "./conversation-session-actions";
import type { createErrorState } from "./error-state.svelte";
import type { createGitAssist } from "./git-assist";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { LspOnboardingStore } from "./lsp-onboarding.svelte";
import type { createPreviewStore } from "./preview.svelte";
import type { createProjectActions } from "./project-actions.svelte";
import type { createProjectDocumentsStore } from "./project-documents.svelte";
import type { createProjectWorkspaceStore } from "./project-workspace.svelte";
import type { createPromptQueueActions } from "./prompt-queue-actions.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import type { createPromptSubmit } from "./prompt-submit";
import type { createQuestionImageController } from "./question-images";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionTabController } from "./session-tab-controller";
import type { createTranscriptAttachmentController } from "./transcript-attachments";
import type { createTranscriptScrollController } from "./transcript-scroll.svelte";
import type { QuotaWaitStore } from "./quota-wait.svelte";
import type { HeadsUpFeedback, HeadsUpStore } from "./heads-up.svelte";
import type { createWorkspaceController } from "./workspace-controller";

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
  brainstormLink?: () => BrainstormSessionLink | undefined;
  openBrainstormSession?: (sessionId: string) => void | Promise<void>;
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
  projectActions: ReturnType<typeof createProjectActions>;
  attachments: ReturnType<typeof createAttachmentDraftController>;
  elicitation: ReturnType<typeof createElicitationStore>;
  questionImages: ReturnType<typeof createQuestionImageController>;
  lspOnboarding: LspOnboardingStore;
  quotaWait: QuotaWaitStore;
  headsUp: HeadsUpStore;
  openBtw?: (sessionId: string, question?: string) => void | Promise<void>;
};

export type WorkbenchEditorBuilderOptions = {
  workspace: () => string;
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
  lspOnboarding: LspOnboardingStore;
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
): Pick<DesktopWorkbenchSurfaceViewProps, "transcript" | "queue" | "composer" | "managedCouncil"> {
  const sessionId = options.activeSessionId();
  const link = options.brainstormLink?.();
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
      workspace: options.workspace(),
      promptRunning: options.promptRunning(),
      agentControlState: options.activeAgentControlState(),
      operationRunning: options.operationRunning() || link?.owned === true,
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
      onUserMessageAction: (message, action) => { if (!link?.owned) void options.branchActions.runUserMessageContextAction(message, action); },
      onHtmlSandboxSubmit: sessionId && !link?.owned
        ? (messageId, payload) => options.promptSubmit.submitHtmlSandbox(sessionId, messageId, payload)
        : undefined,
      lspSuggestion: options.lspOnboarding.activeSuggestion(),
      onInstallLsp: sessionId ? () => void options.lspOnboarding.pauseAndInstall(sessionId) : undefined,
      onDismissLsp: sessionId ? () => options.lspOnboarding.dismiss(sessionId) : undefined,
    },
    queue: {
      items: sessionId ? (options.promptRuntime.queueItemsBySession.get(sessionId) ?? []) : [],
      disabled: options.operationRunning() || options.promptQueue.actionRunning || link?.owned === true,
      onAction: (item, action) => void options.promptQueue.actOnQueuedMessage(item, action),
    },
    composer: {
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
                && !options.brainstormLink?.()?.owned && !options.operationRunning()
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
        && !options.conversationActions.promptEnhancing
        && !link?.owned
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
      onDraftChange: options.draft.promote,
      onOpenHistory: () => options.openHistoryPicker(""),
      onEnhance: () => options.conversationActions.enhancePromptDraft(options.promptText()),
      onSubmit: options.promptSubmit.submit,
      onDefer: options.promptQueue.deferCurrentDraft,
      onFork: options.promptQueue.forkCurrentDraft,
      onCreateTask: options.projectActions.createTaskFromComposer,
      onScheduleContinuation: sessionId ? () => options.quotaWait.openSchedule(sessionId) : undefined,
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
    managedCouncil: link ? { ...link, onOpenParent: () => void options.openBrainstormSession?.(link.parentSessionId) } : undefined,
  };
}

export function buildWorkbenchEditorProps(
  options: WorkbenchEditorBuilderOptions,
): Pick<
  DesktopWorkbenchSurfaceViewProps,
  "preview" | "previewVisible" | "gitDiff" | "gitDiffVisible" | "lspInstall" | "lspInstallVisible" | "terminal" | "terminalVisible"
> {
  const activePreview = options.preview.active;
  const userConfigKind = activePreview?.kind === "file" ? activePreview.userConfigKind : undefined;
  const gitDiffPreview = options.git.diffPreview;
  const lspInstaller = options.lspOnboarding.installer;

  return {
    preview: activePreview ? {
      previewId: activePreview.id,
      active: options.activeWorkbenchTabId() === "preview",
      scrollPosition: activePreview.scrollPosition,
      file: activePreview.kind === "file" ? activePreview.file : undefined,
      lineRange: activePreview.kind === "file" ? activePreview.lineRange : undefined,
      attachment: activePreview.kind === "attachment" ? activePreview.attachment : undefined,
      autoplay: activePreview.kind === "attachment" && activePreview.autoplay === true,
      onAutoplayConsumed: () => options.preview.consumeAutoplay(activePreview.id),
      canGoBack: options.preview.canGoBack,
      canGoForward: options.preview.canGoForward,
      editable: activePreview.kind === "file"
        && (userConfigKind !== undefined || isWorkspaceProjectFilePath(activePreview.file.path)),
      externalEditorLabel: activePreview.kind === "file" && isWorkspaceProjectFilePath(activePreview.file.path)
        ? options.externalEditorLabel()
        : undefined,
      onBack: () => options.preview.move(-1),
      onForward: () => options.preview.move(1),
      onOpenProjectFile: (path, range) => options.preview.openProjectFile(path, "push", range),
      onValidateProjectFile: options.preview.validateProjectFile,
      onValidateLocalFile: options.preview.validateLocalFile,
      onResolveProjectMedia: options.preview.resolveProjectMedia,
      onOpenLocalFile: (path) => options.preview.openLocalFile(path, "push"),
      onResolveLocalMedia: options.preview.resolveLocalMedia,
      onSaveProjectFile: userConfigKind
        ? (path, content) => options.preview.saveUserConfig(userConfigKind, path, content)
        : options.projectDocuments.save,
      onOpenExternalEditor: activePreview.kind === "file" && isWorkspaceProjectFilePath(activePreview.file.path)
        ? (path) => void options.projectWorkspace.openInEditor(path)
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
  };
}
