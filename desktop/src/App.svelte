<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { LogicalPosition } from "@tauri-apps/api/dpi";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { open } from "@tauri-apps/plugin-dialog";
  import type {
    AvailableCommand,
    ContentBlock,
    CreateElicitationRequest,
    CreateElicitationResponse,
    SessionConfigOption,
    SessionInfo,
    SessionNotification,
    SessionUpdate,
  } from "@agentclientprotocol/sdk";
  import {
    AcpClient,
    type PromptFileImage,
    type QueueAction,
    type QueueItem,
    type QueueState,
    type QueuedUserMessage,
    type RuntimeStatus,
  } from "./lib/acp-client";
  import { TauriAcpTransport } from "./lib/tauri-transport";
  import {
    appendLocalSystemMessage,
    appendLocalUserMessage,
    bindLocalUserMessageSessionEntry,
    applyDeferredToolResult,
    applySessionUpdates,
    emptyTranscript,
    finalizeTranscriptActivity,
    hydrateTranscriptAttachment,
    markDeferredToolResults,
    setToolResultLoading,
    type MessageItem,
    type TranscriptState,
  } from "./lib/transcript";
  import {
    DESKTOP_SLASH_COMMANDS,
    mergeSlashCommands,
    parseDesktopSlashCommand,
  } from "./lib/slash-commands";
  import {
    commandPickerState,
    desktopCommandPickerState,
    listCommandPickerState,
    type CommandPickerItem,
    type CommandPickerState,
  } from "./lib/command-interactions";
  import {
    COMMAND_PALETTE_IDS,
    desktopCommandDefinition,
    desktopCommandShortcutLabel,
    isDesktopCommandId,
    matchesDesktopShortcut,
    type DesktopCommandId,
    type DesktopShortcutPlatform,
  } from "./lib/desktop-commands";
  import { clampThinkingLevel, modelThinkingConfigState } from "./lib/model-thinking";
  import {
    ACTIVE_SESSIONS_STORAGE_KEY,
    buildTabSessions,
    mergeRestoredSessionTabs,
    parseActiveSessionIds,
    replaceSessionTab,
    restoredTabSessionIds,
    serializeActiveSessionIds,
    startupSessionId,
  } from "./lib/session-tabs";
  import {
    canAcceptElicitationForSession,
    elicitationBelongsToActiveSession,
    elicitationSessionId,
    parseElicitation,
    type ElicitationField,
  } from "./lib/elicitation";
  import {
    MAX_QUESTION_IMAGE_BYTES,
    MAX_QUESTION_IMAGE_BYTES_TOTAL,
    MAX_QUESTION_IMAGES,
    addQuestionImages,
    createQuestionAcceptResponse,
    createQuestionSelections,
    createQuestionnaireState,
    parseQuestionElicitation,
    totalQuestionImageBytes,
    totalQuestionImageCount,
    type DesktopQuestion,
    type QuestionComposerMode,
    type QuestionImage,
    type QuestionnaireState,
  } from "./lib/question";
  import {
    MAX_ATTACHMENTS,
    MAX_EMBEDDED_ATTACHMENT_BYTES,
    MAX_EMBEDDED_PROMPT_BYTES,
    attachmentDataUrlBytes,
    attachmentFromFile,
    attachmentFromImage,
    attachmentKind,
    extractAttachmentMarkers,
    fileUriFromPath,
    mimeTypeForName,
    type Attachment,
    type AttachmentFile,
  } from "./lib/attachments";
  import {
    buildRecentProjects,
    isAbsoluteProjectPath,
    parseRecentProjects,
    projectName,
    projectWindowRoute,
    projectWindowUrl,
    RECENT_PROJECTS_STORAGE_KEY,
    workspaceFromLocation,
    WORKSPACE_STORAGE_KEY,
  } from "./lib/recent-projects";
  import {
    projectColorFromWorkspaceConfig,
    workspaceConfigWithProjectColor,
    WORKSPACE_CONFIG_PATH,
  } from "./lib/project-colors";
  import {
    EMPTY_RUNTIME_STATUS_GENERATIONS,
    beginRuntimeStatusRefresh,
    isLatestRuntimeStatusRefresh,
    mergeRuntimeStatusResponse,
    type RuntimeStatusGenerations,
  } from "./lib/runtime-status";
  import {
    EMPTY_SESSION_ACTIVITY,
    shouldAcceptSessionActivitySnapshot,
    updateSessionActivitySummary,
    type SessionActivitySummary,
  } from "./lib/session-activity";
  import SessionTabs from "./components/SessionTabs.svelte";
  import SessionSelector from "./components/SessionSelector.svelte";
  import SessionStartView from "./components/SessionStartView.svelte";
  import SessionInspector from "./components/SessionInspector.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import TranscriptPane from "./components/TranscriptPane.svelte";
  import PromptComposer from "./components/PromptComposer.svelte";
  import QueuedMessagesPanel from "./components/QueuedMessagesPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ElicitationDialog from "./components/ElicitationDialog.svelte";
  import CommandPicker from "./components/CommandPicker.svelte";
  import ModelThinkingPicker from "./components/ModelThinkingPicker.svelte";
  import PreviewPane from "./components/PreviewPane.svelte";
  import GitDiffPane from "./components/GitDiffPane.svelte";
  import WorkspaceEditorTabs from "./components/WorkspaceEditorTabs.svelte";
  import WorkspaceSidebar from "./components/WorkspaceSidebar.svelte";
  import type { SessionStateNotification } from "./lib/session-state";
  import {
    agentControlAllowsAutoQueue,
    agentControlStateFromSessionState,
    type AgentControlState,
  } from "./lib/agent-control";
  import {
    registrySnapshotFromSessionState,
    type RegistryActionRequest,
    type RegistrySnapshot,
  } from "./lib/registry";
  import {
    sessionTodoSnapshot,
    updateSessionTodoSnapshots,
    type SessionTodoSnapshot,
  } from "./lib/session-todos";
  import {
    sessionSubagentSnapshot,
    updateSessionSubagentSnapshots,
    type SessionSubagentSnapshot,
  } from "./lib/session-subagents";
  import type { ProjectFileLineRange, ProjectFilePreview } from "./lib/project-files";
  import {
    DEFAULT_EXTERNAL_EDITOR,
    externalEditorLabel,
    resolveDesktopPreferences,
  } from "./lib/desktop-config";
  import {
    updateVisibleModelRefsInPixConfig,
    visibleModelRefsFromPixConfig,
  } from "./lib/model-visibility";
  import type { SettingsConfigDocument } from "./lib/settings";
  import type { ProjectTreeEntry } from "./lib/project-tree";
  import {
    gitDiffForLlm,
    gitReviewHasFindings,
    gitReviewResolutionPrompt,
    type GitDiff,
    type GitDiffScope,
    type GitSnapshot,
  } from "./lib/git";
  import {
    EMPTY_PROJECT_DOCUMENTS,
    PROJECT_TODO_PATH,
    isEditableProjectMarkdown,
    type ProjectDocumentsSnapshot,
  } from "./lib/project-documents";
  import {
    canMovePreviewHistory,
    currentPreview,
    emptyPreviewHistory,
    movePreviewHistory,
    pushPreviewHistory,
    replaceCurrentPreview,
    resetPreviewHistory,
    type PreviewHistory,
    type PreviewScrollPosition,
  } from "./lib/preview-history";
  import {
    normalizeWorkspaceEditor,
    workspaceEditorCloseFallback,
    type WorkspaceEditorId,
    type WorkspaceEditorTab,
  } from "./lib/workspace-editors";
  import {
    EMPTY_TASK_DOCUMENT,
    moveProjectTask,
    parseTaskDocument,
    projectTaskFromComposerDraft,
    projectTaskPromptDraft,
    type ProjectTask,
    type ProjectTaskDocument,
    type ProjectTaskDropPosition,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "./lib/project-tasks";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type PendingFormElicitation = {
    kind: "form";
    sessionId: string | null;
    message: string;
    field: ElicitationField;
    resolve: (response: CreateElicitationResponse) => void;
  };
  type PendingQuestionElicitation = {
    kind: "question";
    sessionId: string | null;
    requestId: number;
    message: string;
    questions: DesktopQuestion[];
    state: QuestionnaireState;
    resolve: (response: CreateElicitationResponse) => void;
  };
  type PendingElicitation = PendingFormElicitation | PendingQuestionElicitation;
  type ProjectTaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
  };
  type PreviewTarget =
    | { kind: "file"; file: ProjectFilePreview; lineRange?: ProjectFileLineRange }
    | { kind: "attachment"; attachment: Attachment };
  type PreviewEntry = PreviewTarget & {
    id: number;
    scrollPosition: PreviewScrollPosition;
  };
  type PreviewNavigation = "replace" | "push";
  type QuestionImageCandidate = {
    name: string;
    size: number;
    mimeType: string;
    readData: () => Promise<string>;
  };

  const SESSION_PREWARM_LIMIT = 2;
  const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 24;
  const RUNTIME_MODEL_USAGE_REFRESH_MS = 5 * 60_000;
  const SESSION_INSPECTOR_OPEN_KEY = "pix.desktop.sessionInspectorOpen";
  const DRAFT_SESSION_TAB_ID = "pix:desktop-draft-session";
  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const desktopShortcutPlatform: DesktopShortcutPlatform = isMacOS ? "mac" : "other";

  let client = $state<AcpClient | null>(null);
  let status = $state<ConnectionStatus>("starting");
  let workspace = $state("");
  let recentProjects = $state<string[]>([]);
  let projectColors = $state<Map<string, string>>(new Map());
  let sessions = $state<SessionInfo[]>([]);
  let savedActiveSessionIds = new Map<string, string>();
  let restoredSessionTabs = $state<string[] | null>(null);
  let locallyOpenedSessionTabs = $state<string[]>([]);
  let closedSessionTabs = $state<string[]>([]);
  let activeSessionId = $state<string | null>(null);
  let transcript = $state<TranscriptState>(emptyTranscript);
  let configOptions = $state<SessionConfigOption[]>([]);
  let promptText = $state("");
  let promptAttachments = $state<Attachment[]>([]);
  let autocompleteEnabled = $state(false);
  let autocompleteDebounceMs = $state(350);
  let runningSessionIds = $state<Set<string>>(new Set());
  let operationRunning = $state(false);
  let sessionHistoryLoading = $state(false);
  let activeSessionRuntimeReady = $state(false);
  let changingConfigBySessionId = $state<Map<string, string>>(new Map());
  const changingConfig = $derived(activeSessionId ? changingConfigBySessionId.get(activeSessionId) ?? null : null);
  let errorMessage = $state<string | null>(null);
  let diagnostics = $state<string[]>([]);
  let pendingElicitationsBySession = $state<Map<string, PendingElicitation>>(new Map());
  let pendingUnscopedElicitation = $state<PendingElicitation | null>(null);
  let commandPicker = $state<CommandPickerState | null>(null);
  let modelThinkingPickerOpen = $state(false);
  let modelThinkingPickerSessionId = $state<string | null>(null);
  let visibleModelRefs = $state<string[] | undefined>(undefined);
  let sessionSelectorOpen = $state(false);
  let sessionSelectorQuery = $state("");
  let sessionSelectorMode = $state<"open" | "delete">("open");
  let draftSessionTabOpen = $state(false);
  let draftSessionTabActive = $state(false);
  let draftSessionTabTouched = $state(false);
  let draftSessionMaterializing = $state(false);
  let sessionInspectorOpen = $state(false);
  let dragActive = $state(false);
  let previewHistory = $state<PreviewHistory<PreviewEntry>>(emptyPreviewHistory());
  let previewDirty = $state(false);
  let activeWorkspaceEditor = $state<WorkspaceEditorId>("conversation");
  let previousWorkspaceEditorSessionId: string | null = null;
  let previewPane = $state<{ requestClose: () => void } | null>(null);
  let taskDocument = $state<ProjectTaskDocument>(EMPTY_TASK_DOCUMENT);
  let tasksLoading = $state(false);
  let tasksSaving = $state(false);
  let taskLoadFailed = $state(false);
  let taskSaveError = $state<string | null>(null);
  let taskActionId = $state<string | null>(null);
  let projectDocuments = $state<ProjectDocumentsSnapshot>(EMPTY_PROJECT_DOCUMENTS);
  let projectDocumentsGeneration = 0;
  let externalEditor = $state(DEFAULT_EXTERNAL_EDITOR);
  let todoSnapshots = $state<Map<string, SessionTodoSnapshot>>(new Map());
  let subagentSnapshots = $state<Map<string, SessionSubagentSnapshot>>(new Map());
  let sessionActivityBySessionId = $state<Map<string, SessionActivitySummary>>(new Map());
  let registrySnapshot = $state<RegistrySnapshot | undefined>(undefined);
  let registryActionId = $state<string | null>(null);
  let gitSnapshot = $state<GitSnapshot | undefined>(undefined);
  let gitLoading = $state(false);
  let gitError = $state<string | null>(null);
  let gitActionId = $state<string | null>(null);
  let gitLlmActionId = $state<string | null>(null);
  let gitResolveRunning = $state(false);
  let gitDiffPreview = $state<GitDiff | null>(null);
  let gitDiffReview = $state<string | undefined>(undefined);
  let slashCommandsBySession = $state<Map<string, AvailableCommand[]>>(new Map());
  let queueItemsBySession = $state<Map<string, QueueItem[]>>(new Map());
  let agentControlStates = $state<Map<string, AgentControlState>>(new Map());
  let runtimeStatusBySessionId = $state<Map<string, RuntimeStatus>>(new Map());
  let modelUsageRefreshSessionIds = $state<Set<string>>(new Set());
  let dcpStatsRefreshSessionIds = $state<Set<string>>(new Set());
  let dcpCompressionSessionIds = $state<Set<string>>(new Set());
  let queueActionRunning = $state(false);
  let imagePromptSupported = false;
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let transcriptContent = $state<HTMLDivElement | null>(null);
  let transcriptFollowsLatest = $state(true);
  let promptComposer = $state<{
    focus: () => Promise<void>;
    insertPaths: (paths: readonly string[]) => Promise<void>;
  } | null>(null);
  let workspaceSidebar = $state<{
    openTasksPanel: (taskId?: string) => Promise<void>;
    closeProjectSwitcher: () => void;
  } | null>(null);
  let localMessageId = 0;
  let reconnectPromise: Promise<void> | null = null;
  let sessionRefreshRequest: { client: AcpClient; workspace: string; promise: Promise<void> } | null = null;
  let sessionRefreshGeneration = 0;
  let sessionPrewarmGeneration = 0;
  let autocompleteSettingsGeneration = 0;
  let attachmentSequence = 0;
  let previewSequence = 0;
  let visibleModelsSavePromise: Promise<void> | null = null;
  let attachmentDraftGeneration = 0;
  const attachmentAddQueues = new Map<string, Promise<void>>();
  let pendingSessionUpdates: Array<{ sessionId: string; update: SessionUpdate; occurredAtMs: number }> = [];
  let sessionUpdateFrame = 0;
  let transcriptScrollFrame = 0;
  let sessionHistoryGeneration = 0;
  let draftSessionMaterializationGeneration = 0;
  let previousAttachmentDraftKey: string | null = null;
  let previousPreviewWorkspace: string | null = null;
  let projectFilePreviewGeneration = 0;
  let projectColorLoadGeneration = 0;
  let projectColorSaveGeneration = 0;
  let taskLoadGeneration = 0;
  let gitLoadGeneration = 0;
  let elicitationSequence = 0;
  let questionImageOperationSequence = 0;
  let questionImageOperationIds = $state<Map<number, number>>(new Map());
  const registeredAttachmentPaths = new Set<string>();
  const preparingAttachmentPaths = new Map<string, Promise<void>>();
  const preparingDeferredImages = new Map<string, Promise<void>>();
  const loadingToolResults = new Set<string>();
  const transcriptBySessionId = new Map<string, TranscriptState>();
  const runtimeReadySessionIds = new Set<string>();
  const runtimeLoadsBySessionId = new Map<string, Promise<void>>();
  const runtimeLoadGenerations = new Map<string, number>();
  const configOptionsBySessionId = new Map<string, SessionConfigOption[]>();
  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const promptEndedAtBySessionId = new Map<string, number>();
  const autoFlushInProgress = new Set<string>();
  const runtimeStatusGenerationsBySession = new Map<string, RuntimeStatusGenerations>();
  const dcpStatsRequestGenerations = new Map<string, number>();
  const configChangeGenerations = new Map<string, number>();
  const sessionActivityForgottenAt = new Map<string, number>();

  const sessionMutationRunning = $derived(operationRunning || draftSessionMaterializing);
  const canUseSession = $derived(status === "ready" && !!workspace && !sessionMutationRunning);
  const promptRunning = $derived(activeSessionId ? runningSessionIds.has(activeSessionId) : false);
  const activeAgentControlState = $derived(
    activeSessionId ? (agentControlStates.get(activeSessionId) ?? "idle") : "idle",
  );
  const anyPromptRunning = $derived(runningSessionIds.size > 0);
  const activeTitle = $derived(
    sessions.find((session) => session.sessionId === activeSessionId)?.title ?? "New conversation",
  );
  const tabSessions = $derived(buildTabSessions(
    sessions,
    restoredSessionTabs,
    locallyOpenedSessionTabs,
    closedSessionTabs,
    activeSessionId,
  ));
  const draftSessionInfo = $derived<SessionInfo>({
    sessionId: DRAFT_SESSION_TAB_ID,
    cwd: workspace,
    title: "New conversation",
    updatedAt: null,
  });
  const titlebarSessions = $derived(
    draftSessionTabOpen ? [...tabSessions, draftSessionInfo] : tabSessions,
  );
  const activeConversationTabId = $derived(
    draftSessionTabActive ? DRAFT_SESSION_TAB_ID : activeSessionId,
  );
  const sessionStartOpen = $derived(draftSessionTabActive && !draftSessionTabTouched);
  const sessionStartCandidates = $derived.by<SessionInfo[]>(() => {
    const openIds = new Set(tabSessions.map((session) => session.sessionId));
    return sessions.filter((session) => !openIds.has(session.sessionId));
  });
  const attachmentDraftKey = $derived(
    `${workspace}\0${draftSessionTabActive ? DRAFT_SESSION_TAB_ID : activeSessionId ?? ""}`,
  );
  const activePreview = $derived(currentPreview(previewHistory));
  const canGoBackInPreview = $derived(canMovePreviewHistory(previewHistory, -1));
  const canGoForwardInPreview = $derived(canMovePreviewHistory(previewHistory, 1));
  const workspaceEditorTabs = $derived.by<WorkspaceEditorTab[]>(() => {
    const tabs: WorkspaceEditorTab[] = [{
      id: "conversation",
      label: "Conversation",
      title: activeTitle,
      kind: "conversation",
      closable: false,
    }];
    if (activePreview) {
      const previewTitle = activePreview.kind === "file"
        ? activePreview.file.path
        : activePreview.attachment.name;
      tabs.push({
        id: "preview",
        label: workspaceEditorLabel(previewTitle),
        title: previewTitle,
        kind: "file",
        closable: true,
        dirty: previewDirty,
      });
    }
    if (gitDiffPreview) {
      const target = gitDiffPreview.path ?? "All changes";
      tabs.push({
        id: "git-diff",
        label: gitDiffPreview.path ? `${workspaceEditorLabel(target)} · Diff` : "All Changes · Diff",
        title: `${target} · ${gitDiffPreview.scope}`,
        kind: "diff",
        closable: true,
        busy: gitLlmActionId?.startsWith("review:") === true || gitResolveRunning,
      });
    }
    return tabs;
  });
  const activeTodoSnapshot = $derived(activeSessionId ? todoSnapshots.get(activeSessionId) : undefined);
  const activeSubagentSnapshot = $derived(activeSessionId ? subagentSnapshots.get(activeSessionId) : undefined);
  const activeSessionActivity = $derived(
    activeSessionId ? (sessionActivityBySessionId.get(activeSessionId) ?? EMPTY_SESSION_ACTIVITY) : EMPTY_SESSION_ACTIVITY,
  );
  const activePendingElicitation = $derived.by<PendingElicitation | null>(() => {
    const pending = pendingUnscopedElicitation
      ?? (activeSessionId ? pendingElicitationsBySession.get(activeSessionId) ?? null : null);
    return pending && elicitationBelongsToActiveSession(pending.sessionId, activeSessionId) ? pending : null;
  });
  const pendingElicitationSessionIds = $derived.by<ReadonlySet<string>>(() => {
    const sessionIds = new Set(pendingElicitationsBySession.keys());
    if (pendingUnscopedElicitation && activeSessionId) sessionIds.add(activeSessionId);
    return sessionIds;
  });
  const activeRegistrySnapshot = $derived(registrySnapshot);
  const externalEditorDisplayName = $derived(externalEditorLabel(externalEditor));
  const registryLoading = $derived(registryActionId === "refresh");
  const activeQueueItems = $derived(activeSessionId ? (queueItemsBySession.get(activeSessionId) ?? []) : []);
  const activeRuntimeStatus = $derived(activeSessionId ? runtimeStatusBySessionId.get(activeSessionId) : undefined);
  const modelUsageRefreshing = $derived(activeSessionId ? modelUsageRefreshSessionIds.has(activeSessionId) : false);
  const dcpStatsRefreshing = $derived(activeSessionId ? dcpStatsRefreshSessionIds.has(activeSessionId) : false);
  const dcpCompressionRunning = $derived(activeSessionId ? dcpCompressionSessionIds.has(activeSessionId) : false);
  const activeSlashCommands = $derived(
    mergeSlashCommands(
      DESKTOP_SLASH_COMMANDS,
      activeSessionId ? (slashCommandsBySession.get(activeSessionId) ?? []) : [],
    ),
  );
  const dcpCompressionAvailable = $derived(
    activeSlashCommands.some((command) => command.name.toLowerCase() === "dcp"),
  );

  $effect(() => {
    if (modelThinkingPickerOpen && modelThinkingPickerSessionId !== activeSessionId) {
      modelThinkingPickerOpen = false;
      modelThinkingPickerSessionId = null;
    }
  });
  let runtimeStatusActivationKey = "";
  $effect(() => {
    const sessionId = activeSessionId;
    const modelThinking = modelThinkingConfigState(configOptions);
    const currentModel = modelThinking.currentModel?.ref ?? "";
    const currentThinking = modelThinking.currentThinking;
    if (status !== "ready" || !sessionId || !activeSessionRuntimeReady) {
      runtimeStatusActivationKey = "";
      return;
    }
    const key = `${sessionId}\0${currentModel}\0${currentThinking}`;
    if (runtimeStatusActivationKey === key) return;
    runtimeStatusActivationKey = key;
    queueMicrotask(() => void refreshRuntimeStatus(sessionId, true));
  });
  const questionMode = $derived.by<QuestionComposerMode | undefined>(() => {
    const pending = activePendingElicitation;
    if (!pending || pending.kind !== "question") return undefined;
    const requestId = pending.requestId;
    return {
      message: pending.message,
      questions: pending.questions,
      state: pending.state,
      addingImages: questionImageOperationIds.has(requestId),
      onStateChange: (state) => updateQuestionnaire(state, requestId),
      onSubmit: (state) => answerQuestion(state, requestId),
      onCancel: () => cancelElicitation(requestId),
      onChooseImages: (questionId) => chooseQuestionImages(questionId, requestId),
      onPasteImages: (questionId, files) => addPastedQuestionImages(questionId, files, requestId),
      onOpenImage: openQuestionImage,
    };
  });

  $effect(() => {
    const key = attachmentDraftKey;
    if (previousAttachmentDraftKey !== null && previousAttachmentDraftKey !== key) {
      invalidateAttachmentDraft();
      projectFilePreviewGeneration += 1;
    }
    previousAttachmentDraftKey = key;

    const currentWorkspace = workspace;
    if (previousPreviewWorkspace !== null && previousPreviewWorkspace !== currentWorkspace) {
      previewHistory = emptyPreviewHistory();
      previewDirty = false;
    }
    previousPreviewWorkspace = currentWorkspace;
  });

  $effect(() => {
    const sessionId = activeSessionId;
    if (previousWorkspaceEditorSessionId !== sessionId) activeWorkspaceEditor = "conversation";
    previousWorkspaceEditorSessionId = sessionId;
  });

  $effect(() => {
    const normalized = normalizeWorkspaceEditor(activeWorkspaceEditor, workspaceEditorTabs);
    if (normalized !== activeWorkspaceEditor) activeWorkspaceEditor = normalized;
  });

  $effect(() => {
    const requestClient = client;
    const sessionId = activeSessionId;
    const sessionReady = status === "ready"
      && activeSessionRuntimeReady
      && !operationRunning
      && !sessionHistoryLoading;
    const generation = ++autocompleteSettingsGeneration;
    autocompleteEnabled = false;
    autocompleteDebounceMs = 350;
    // session/load exposes the active id before the ACP backend has finished
    // registering it. Retry when that lifecycle operation settles.
    if (!requestClient || !sessionId || !sessionReady) return;
    void requestClient.autocompleteSettings(sessionId)
      .then((settings) => {
        if (
          generation !== autocompleteSettingsGeneration
          || requestClient !== client
          || sessionId !== activeSessionId
        ) return;
        autocompleteEnabled = settings.enabled;
        autocompleteDebounceMs = settings.debounceMs;
      })
      .catch(() => {});
  });

  $effect(() => {
    const sessionId = activeSessionId;
    const frame = requestAnimationFrame(() => {
      if (sessionId !== activeSessionId) return;
      transcriptFollowsLatest = true;
      scheduleScrollToLatest();
    });
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    const pane = transcriptPane;
    const content = transcriptContent;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (transcriptFollowsLatest) scheduleScrollToLatest();
    });
    observer.observe(pane);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  });

  onMount(() => {
    let disposed = false;
    let unlistenDragDrop: (() => void) | undefined;
    const runtimeStatusTimer = window.setInterval(() => {
      const sessionId = activeSessionId;
      if (sessionId && activeSessionRuntimeReady) void refreshRuntimeStatus(sessionId, true);
    }, RUNTIME_MODEL_USAGE_REFRESH_MS);
    restoreProjects();
    refreshProjectColors(recentProjects);
    try {
      sessionInspectorOpen = localStorage.getItem(SESSION_INSPECTOR_OPEN_KEY) === "true";
    } catch {
      sessionInspectorOpen = false;
    }
    if (workspace) {
      void loadProjectTasks(workspace);
      void loadProjectDocuments(workspace);
      void loadDesktopPreferences(workspace);
    }
    void getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        dragActive = canAcceptDroppedAttachments();
      } else if (payload.type === "leave") {
        dragActive = false;
      } else if (payload.type === "drop") {
        dragActive = false;
        const questionId = activeCustomQuestionId();
        if (questionId) {
          void addQuestionImagePaths(questionId, payload.paths);
        } else if (
          (activeSessionId || draftSessionTabActive)
          && !sessionMutationRunning
          && activePendingElicitation?.kind !== "question"
        ) {
          void promptComposer?.insertPaths(payload.paths);
        }
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenDragDrop = unlisten;
    }).catch(reportError);
    void connect().then(() => {
      if (disposed) void client?.dispose();
    });
    return () => {
      disposed = true;
      window.clearInterval(runtimeStatusTimer);
      unlistenDragDrop?.();
      if (sessionUpdateFrame) cancelAnimationFrame(sessionUpdateFrame);
      if (transcriptScrollFrame) cancelAnimationFrame(transcriptScrollFrame);
      pendingSessionUpdates = [];
      cancelAllPendingElicitations();
      void client?.dispose();
    };
  });

  function setSessionInspectorOpen(next: boolean): void {
    sessionInspectorOpen = next;
    try {
      localStorage.setItem(SESSION_INSPECTOR_OPEN_KEY, String(next));
    } catch {
      // Persistence is a convenience; keep the in-memory preference.
    }
  }

  async function connect(): Promise<void> {
    status = "starting";
    errorMessage = null;
    let next: AcpClient;
    next = new AcpClient(new TauriAcpTransport(), {
      onSessionUpdate: (notification) => {
        if (client === next) handleSessionUpdate(notification);
      },
      onSessionState: (notification) => {
        if (client === next) handleSessionState(notification);
      },
      onQueueState: (state) => {
        if (client === next) handleQueueState(state);
      },
      onQueueConsumed: (sessionId, message) => {
        if (client === next) handleQueueConsumed(sessionId, message);
      },
      onElicitation: (request): Promise<CreateElicitationResponse> => client === next
        ? requestElicitation(request)
        : Promise.resolve({ action: "cancel" }),
      onDiagnostic: (line) => {
        if (client !== next) return;
        diagnostics = [...diagnostics.slice(-49), line];
      },
      onExit: (exit) => {
        if (client !== next) return;
        closeProjectSelector();
        closeSessionSelector();
        commandPicker = null;
        cancelAllPendingElicitations();
        activeSessionId = null;
        activeSessionRuntimeReady = false;
        runtimeReadySessionIds.clear();
        runtimeLoadsBySessionId.clear();
        configOptionsBySessionId.clear();
        transcriptBySessionId.clear();
        sessionPrewarmGeneration += 1;
        todoSnapshots = new Map();
        subagentSnapshots = new Map();
        sessionActivityBySessionId = new Map();
        sessionActivityForgottenAt.clear();
        registrySnapshot = undefined;
        registryActionId = null;
        gitResolveRunning = false;
        slashCommandsBySession = new Map();
        queueItemsBySession = new Map();
        agentControlStates = new Map();
        runtimeStatusBySessionId = new Map();
        modelUsageRefreshSessionIds = new Set();
        dcpStatsRefreshSessionIds = new Set();
        dcpCompressionSessionIds = new Set();
        runtimeStatusGenerationsBySession.clear();
        dcpStatsRequestGenerations.clear();
        transcript = emptyTranscript;
        configOptions = [];
        status = exit.requested ? "stopped" : "error";
        if (!exit.requested) {
          errorMessage = exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`;
        }
        runningSessionIds = new Set();
        operationRunning = false;
        configChangeGenerations.clear();
        changingConfigBySessionId = new Map();
      },
    });
    client = next;
    try {
      const initialization = await next.start();
      if (client !== next) {
        await next.dispose();
        return;
      }
      imagePromptSupported = initialization.agentCapabilities?.promptCapabilities?.image === true;
      status = "ready";
      if (workspace) await openWorkspaceSession();
    } catch (error) {
      if (client !== next) return;
      status = "error";
      reportError(error);
    }
  }

  async function reconnect(): Promise<void> {
    if (reconnectPromise) return reconnectPromise;
    reconnectPromise = performReconnect().finally(() => {
      reconnectPromise = null;
    });
    return reconnectPromise;
  }

  async function performReconnect(): Promise<void> {
    const previous = client;
    client = null;
    closeProjectSelector();
    closeSessionSelector();
    commandPicker = null;
    cancelAllPendingElicitations();
    activeSessionId = null;
    activeSessionRuntimeReady = false;
    runtimeReadySessionIds.clear();
    runtimeLoadsBySessionId.clear();
    configOptionsBySessionId.clear();
    promptEndedAtBySessionId.clear();
    transcriptBySessionId.clear();
    sessionPrewarmGeneration += 1;
    todoSnapshots = new Map();
    subagentSnapshots = new Map();
    sessionActivityBySessionId = new Map();
    sessionActivityForgottenAt.clear();
    registrySnapshot = undefined;
    registryActionId = null;
    gitResolveRunning = false;
    slashCommandsBySession = new Map();
    queueItemsBySession = new Map();
    agentControlStates = new Map();
    runtimeStatusBySessionId = new Map();
    modelUsageRefreshSessionIds = new Set();
    dcpStatsRefreshSessionIds = new Set();
    dcpCompressionSessionIds = new Set();
    runtimeStatusGenerationsBySession.clear();
    dcpStatsRequestGenerations.clear();
    transcript = emptyTranscript;
    configOptions = [];
    runningSessionIds = new Set();
    operationRunning = false;
    configChangeGenerations.clear();
    changingConfigBySessionId = new Map();
    await previous?.dispose().catch(() => {});
    await connect();
  }

  function handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      const next = new Map(slashCommandsBySession);
      next.set(notification.sessionId, update.availableCommands);
      slashCommandsBySession = next;
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      configOptionsBySessionId.set(notification.sessionId, update.configOptions);
      if (notification.sessionId === activeSessionId) configOptions = update.configOptions;
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      sessions = sessions.map((session) => session.sessionId === notification.sessionId
        ? {
            ...session,
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
          }
        : session);
      return;
    }
    pendingSessionUpdates.push({ sessionId: notification.sessionId, update, occurredAtMs: Date.now() });
    if (sessionUpdateFrame) return;
    sessionUpdateFrame = requestAnimationFrame(flushSessionUpdates);
  }

  function flushSessionUpdates(): void {
    sessionUpdateFrame = 0;
    const queued = pendingSessionUpdates;
    pendingSessionUpdates = [];
    if (queued.length === 0) return;

    const activeId = activeSessionId;
    const updatesBySession = new Map<string, Array<{ update: SessionUpdate; occurredAtMs: number }>>();
    for (const entry of queued) {
      const updates = updatesBySession.get(entry.sessionId);
      if (updates) updates.push({ update: entry.update, occurredAtMs: entry.occurredAtMs });
      else updatesBySession.set(entry.sessionId, [{ update: entry.update, occurredAtMs: entry.occurredAtMs }]);
    }

    for (const [sessionId, entries] of updatesBySession) {
      const current = sessionId === activeId
        ? transcript
        : transcriptBySessionId.get(sessionId) ?? emptyTranscript;
      let nextTranscript = applySessionUpdates(
        current,
        entries.map((entry) => entry.update),
        entries.map((entry) => entry.occurredAtMs),
      );
      const promptEndedAtMs = promptEndedAtBySessionId.get(sessionId);
      if (promptEndedAtMs !== undefined && !runningSessionIds.has(sessionId)) {
        nextTranscript = finalizeTranscriptActivity(nextTranscript, promptEndedAtMs);
        promptEndedAtBySessionId.delete(sessionId);
      }
      transcriptBySessionId.set(sessionId, nextTranscript);
      if (sessionId === activeId) transcript = nextTranscript;
    }
    if (activeId && transcriptFollowsLatest) scheduleScrollToLatest();
  }

  function transcriptIsNearBottom(): boolean {
    const pane = transcriptPane;
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
  }

  function handleTranscriptScroll(): void {
    const followsLatest = transcriptIsNearBottom();
    if (followsLatest === transcriptFollowsLatest) return;
    transcriptFollowsLatest = followsLatest;
    if (!followsLatest && transcriptScrollFrame) {
      cancelAnimationFrame(transcriptScrollFrame);
      transcriptScrollFrame = 0;
    }
  }

  function jumpToLatest(): void {
    transcriptFollowsLatest = true;
    scheduleScrollToLatest();
  }

  function scheduleScrollToLatest(): void {
    if (!transcriptFollowsLatest || transcriptScrollFrame) return;
    transcriptScrollFrame = requestAnimationFrame(() => {
      transcriptScrollFrame = 0;
      if (!transcriptFollowsLatest) return;
      const pane = transcriptPane;
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  function handleSessionState(notification: SessionStateNotification): void {
    const agentControlState = agentControlStateFromSessionState(notification);
    if (agentControlState) {
      setLocalAgentControlState(notification.sessionId, agentControlState);
      return;
    }
    const nextRegistrySnapshot = registrySnapshotFromSessionState(notification);
    if (nextRegistrySnapshot) {
      const sourceSession = sessions.find((session) => session.sessionId === notification.sessionId);
      if (sourceSession && sourceSession.cwd !== workspace) return;
      registrySnapshot = nextRegistrySnapshot;
      return;
    }
    const todoSnapshot = sessionTodoSnapshot(notification);
    if (todoSnapshot) {
      const previous = todoSnapshots.get(notification.sessionId);
      if (!shouldAcceptSessionActivitySnapshot(
        todoSnapshot.checkedAt,
        previous?.checkedAt,
        sessionActivityForgottenAt.get(notification.sessionId),
      )) return;
      todoSnapshots = updateSessionTodoSnapshots(todoSnapshots, notification.sessionId, todoSnapshot);
      sessionActivityBySessionId = updateSessionActivitySummary(
        sessionActivityBySessionId,
        notification.sessionId,
        todoSnapshots.get(notification.sessionId),
        subagentSnapshots.get(notification.sessionId),
      );
      return;
    }
    const subagentSnapshot = sessionSubagentSnapshot(notification);
    if (subagentSnapshot) {
      const previous = subagentSnapshots.get(notification.sessionId);
      if (!shouldAcceptSessionActivitySnapshot(
        subagentSnapshot.checkedAt,
        previous?.checkedAt,
        sessionActivityForgottenAt.get(notification.sessionId),
      )) return;
      subagentSnapshots = updateSessionSubagentSnapshots(subagentSnapshots, notification.sessionId, subagentSnapshot);
      sessionActivityBySessionId = updateSessionActivitySummary(
        sessionActivityBySessionId,
        notification.sessionId,
        todoSnapshots.get(notification.sessionId),
        subagentSnapshots.get(notification.sessionId),
      );
    }
  }

  function handleQueueState(state: QueueState): void {
    const next = new Map(queueItemsBySession);
    next.set(state.sessionId, [...state.items]);
    queueItemsBySession = next;
    if (!runningSessionIds.has(state.sessionId)) void flushAutoQueue(state.sessionId);
  }

  function handleQueueConsumed(sessionId: string, message: QueuedUserMessage): void {
    appendQueuedMessageToTranscript(sessionId, message);
  }

  async function runRegistryAction(request: RegistryActionRequest, actionId: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (
      !requestClient
      || !sessionId
      || !activeSessionRuntimeReady
      || operationRunning
      || promptRunning
      || sessionHistoryLoading
      || registryActionId !== null
    ) return;

    registryActionId = actionId;
    operationRunning = true;
    errorMessage = null;
    try {
      await requestClient.registryAction(sessionId, request);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      if (request.action === "pull-project") {
        if (request.scope === "tasks" || request.scope === "project") void loadProjectTasks(workspace);
        if (request.scope === "plans" || request.scope === "todo" || request.scope === "project") void loadProjectDocuments(workspace);
      }
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      if (requestClient === client && sessionId === activeSessionId) {
        registryActionId = null;
        operationRunning = false;
      }
    }
  }

  function refreshRegistry(): void {
    void runRegistryAction({ action: "refresh" }, "refresh");
  }

  async function refreshQueueState(sessionId: string): Promise<void> {
    const requestClient = client;
    if (!requestClient || !runtimeReadySessionIds.has(sessionId)) return;
    try {
      const state = await requestClient.queueState(sessionId);
      if (requestClient !== client) return;
      handleQueueState(state);
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    }
  }

  async function refreshRuntimeStatus(sessionId: string, refreshModelUsage = false): Promise<void> {
    const requestClient = client;
    if (!requestClient || !runtimeReadySessionIds.has(sessionId)) return;
    const request = beginRuntimeStatusRefresh(
      runtimeStatusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
      refreshModelUsage,
    );
    runtimeStatusGenerationsBySession.set(sessionId, request.generations);

    if (refreshModelUsage) {
      const refreshing = new Set(modelUsageRefreshSessionIds);
      refreshing.add(sessionId);
      modelUsageRefreshSessionIds = refreshing;
    }

    try {
      const next = await requestClient.runtimeStatus(sessionId, refreshModelUsage);
      if (requestClient !== client || !runtimeReadySessionIds.has(sessionId)) return;
      const merged = mergeRuntimeStatusResponse(
        runtimeStatusBySessionId.get(sessionId),
        next,
        isLatestRuntimeStatusRefresh(
          runtimeStatusGenerationsBySession.get(sessionId) ?? EMPTY_RUNTIME_STATUS_GENERATIONS,
          request.snapshotGeneration,
          request.quotaGeneration,
        ),
      );
      const statuses = new Map(runtimeStatusBySessionId);
      statuses.set(sessionId, merged);
      runtimeStatusBySessionId = statuses;
    } catch {
      // Runtime chrome is best-effort. Keep the previous snapshot when the
      // private status request races a session reload or transient transport failure.
    } finally {
      // Only the newest quota refresh owns the busy state; it is invalidated by
      // a newer quota refresh generation, never by snapshot refreshes.
      const live = runtimeStatusGenerationsBySession.get(sessionId);
      if (request.quotaGeneration !== undefined && live?.quota === request.quotaGeneration) {
        const refreshing = new Set(modelUsageRefreshSessionIds);
        refreshing.delete(sessionId);
        modelUsageRefreshSessionIds = refreshing;
      }
    }
  }

  function refreshActiveModelUsage(): void {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    void refreshRuntimeStatus(sessionId, true);
  }

  async function refreshActiveDcpStats(): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !runtimeReadySessionIds.has(sessionId) || dcpStatsRefreshSessionIds.has(sessionId)) return;

    const generation = (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1;
    dcpStatsRequestGenerations.set(sessionId, generation);

    const refreshing = new Set(dcpStatsRefreshSessionIds);
    refreshing.add(sessionId);
    dcpStatsRefreshSessionIds = refreshing;
    try {
      const next = await requestClient.dcpStats(sessionId);
      if (
        requestClient !== client
        || !runtimeReadySessionIds.has(sessionId)
        || dcpStatsRequestGenerations.get(sessionId) !== generation
      ) return;
      const previous = runtimeStatusBySessionId.get(sessionId);
      if (!previous) return;
      const { dcpStats: _staleDcpStats, ...withoutDcpStats } = previous;
      const statuses = new Map(runtimeStatusBySessionId);
      statuses.set(sessionId, {
        ...withoutDcpStats,
        ...(next.dcpStats ? { dcpStats: next.dcpStats } : {}),
      });
      runtimeStatusBySessionId = statuses;
    } catch {
      // DCP telemetry is best-effort; keep the last successfully loaded snapshot.
    } finally {
      if (dcpStatsRequestGenerations.get(sessionId) !== generation) return;
      const next = new Set(dcpStatsRefreshSessionIds);
      next.delete(sessionId);
      dcpStatsRefreshSessionIds = next;
    }
  }

  async function compressActiveDcpContext(): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const agentControlState = sessionId ? (agentControlStates.get(sessionId) ?? "idle") : "idle";
    if (
      !requestClient
      || !sessionId
      || !runtimeReadySessionIds.has(sessionId)
      || runningSessionIds.has(sessionId)
      || promptRunsBySessionId.has(sessionId)
      || operationRunning
      || sessionHistoryLoading
      || agentControlState !== "idle"
      || !dcpCompressionAvailable
      || dcpCompressionSessionIds.has(sessionId)
    ) return;

    const compressing = new Set(dcpCompressionSessionIds);
    compressing.add(sessionId);
    dcpCompressionSessionIds = compressing;
    try {
      await runPromptRequest(requestClient, sessionId, [{ type: "text", text: "/dcp compress" }]);
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      const next = new Set(dcpCompressionSessionIds);
      next.delete(sessionId);
      dcpCompressionSessionIds = next;
    }
  }

  function clearSessionActivity(sessionId: string): void {
    const nextTodos = new Map(todoSnapshots);
    nextTodos.delete(sessionId);
    todoSnapshots = nextTodos;
    const nextSubagents = new Map(subagentSnapshots);
    nextSubagents.delete(sessionId);
    subagentSnapshots = nextSubagents;
    const nextActivity = new Map(sessionActivityBySessionId);
    nextActivity.delete(sessionId);
    sessionActivityBySessionId = nextActivity;
    const nextCommands = new Map(slashCommandsBySession);
    nextCommands.delete(sessionId);
    slashCommandsBySession = nextCommands;
    const nextQueue = new Map(queueItemsBySession);
    nextQueue.delete(sessionId);
    queueItemsBySession = nextQueue;
    const nextAgentControls = new Map(agentControlStates);
    nextAgentControls.delete(sessionId);
    agentControlStates = nextAgentControls;
    promptRunsBySessionId.delete(sessionId);
    promptEndedAtBySessionId.delete(sessionId);
    autoFlushInProgress.delete(sessionId);
  }

  function setSessionPromptRunning(sessionId: string, running: boolean): void {
    const next = new Set(runningSessionIds);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    runningSessionIds = next;
  }

  function setLocalAgentControlState(sessionId: string, state: AgentControlState): void {
    const next = new Map(agentControlStates);
    next.set(sessionId, state);
    agentControlStates = next;
  }

  function finalizeSessionTranscriptActivity(sessionId: string, endedAtMs: number): void {
    const current = sessionId === activeSessionId
      ? transcript
      : transcriptBySessionId.get(sessionId);
    if (!current) return;
    const next = finalizeTranscriptActivity(current, endedAtMs);
    if (next === current) return;
    transcriptBySessionId.set(sessionId, next);
    if (sessionId === activeSessionId) transcript = next;
  }

  function runPromptRequest(
    requestClient: AcpClient,
    sessionId: string,
    blocks: ContentBlock[],
    fileImages: readonly PromptFileImage[] = [],
    transcriptMessageId?: string,
  ): Promise<void> {
    if (promptRunsBySessionId.has(sessionId)) {
      return Promise.reject(new Error("A prompt is already running for this conversation."));
    }
    promptEndedAtBySessionId.delete(sessionId);
    setSessionPromptRunning(sessionId, true);
    const branchBefore = transcriptMessageId
      ? requestClient.branchUserMessages(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);
    let tracked!: Promise<void>;
    tracked = (async () => {
      const before = await branchBefore;
      let promptError: unknown;
      try {
        await requestClient.prompt(sessionId, blocks, fileImages);
      } catch (error) {
        promptError = error;
      }
      if (transcriptMessageId && before) {
        const after = await requestClient.branchUserMessages(sessionId).catch(() => undefined);
        if (after) {
          const beforeIds = new Set(before.map((message) => message.entryId));
          const sessionEntryId = after.filter((message) => !beforeIds.has(message.entryId)).at(-1)?.entryId;
          const current = sessionId === activeSessionId
            ? transcript
            : transcriptBySessionId.get(sessionId);
          if (current) {
            const next = bindLocalUserMessageSessionEntry(current, transcriptMessageId, sessionEntryId);
            transcriptBySessionId.set(sessionId, next);
            if (sessionId === activeSessionId) transcript = next;
          }
        }
      }
      if (promptError !== undefined) throw promptError;
    })()
      .finally(() => {
        if (promptRunsBySessionId.get(sessionId) !== tracked) return;
        promptRunsBySessionId.delete(sessionId);
        const endedAtMs = Date.now();
        promptEndedAtBySessionId.set(sessionId, endedAtMs);
        setSessionPromptRunning(sessionId, false);
        finalizeSessionTranscriptActivity(sessionId, endedAtMs);
        queueMicrotask(() => void refreshRuntimeStatus(sessionId));
        queueMicrotask(() => void flushAutoQueue(sessionId));
      });
    promptRunsBySessionId.set(sessionId, tracked);
    return tracked;
  }

  async function flushAutoQueue(sessionId: string): Promise<void> {
    const requestClient = client;
    if (
      !requestClient
      || !runtimeReadySessionIds.has(sessionId)
      || runningSessionIds.has(sessionId)
      || promptRunsBySessionId.has(sessionId)
      || autoFlushInProgress.has(sessionId)
      || !agentControlAllowsAutoQueue(agentControlStates.get(sessionId))
    ) return;

    autoFlushInProgress.add(sessionId);
    try {
      while (
        requestClient === client
        && runtimeReadySessionIds.has(sessionId)
        && !runningSessionIds.has(sessionId)
        && agentControlAllowsAutoQueue(agentControlStates.get(sessionId))
      ) {
        const message = await requestClient.takeAutoMessage(sessionId);
        if (!message) return;
        const transcriptMessageId = appendQueuedMessageToTranscript(sessionId, message);
        try {
          await runPromptRequest(requestClient, sessionId, queuedMessageBlocks(message), [], transcriptMessageId);
        } catch (error) {
          // Do not drop a message that lost a race with another prompt. Put it
          // back into Pix's auto/steering path; queue state remains visible.
          await requestClient.queueMessage(
            sessionId,
            queuedMessageBlocks(message),
            message.displayText,
          ).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      autoFlushInProgress.delete(sessionId);
    }
  }

  function queuedMessageBlocks(message: QueuedUserMessage): ContentBlock[] {
    return [
      ...(message.promptText ? [{ type: "text" as const, text: message.promptText }] : []),
      ...message.images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ];
  }

  function queuedMessageDraft(message: QueuedUserMessage): { text: string; attachments: Attachment[] } {
    const parsed = extractAttachmentMarkers(message.promptText, `queue:${message.id}`);
    const images = message.images.map((image) =>
      attachmentFromImage(image.data, image.mimeType, nextAttachmentId()));
    return {
      text: parsed.text || message.displayText,
      attachments: [...parsed.attachments, ...images],
    };
  }

  function appendQueuedMessageToTranscript(sessionId: string, message: QueuedUserMessage): string {
    const messageId = `queued:${message.id}`;
    const current = sessionId === activeSessionId
      ? transcript
      : transcriptBySessionId.get(sessionId) ?? emptyTranscript;
    if (current.items.some((item) => item.type === "message" && item.id === messageId)) return messageId;
    const draft = queuedMessageDraft(message);
    const next = appendLocalUserMessage(current, message.displayText || draft.text, messageId, draft.attachments);
    transcriptBySessionId.set(sessionId, next);
    if (sessionId === activeSessionId) {
      transcript = next;
      if (transcriptFollowsLatest) scheduleScrollToLatest();
    }
    return messageId;
  }

  function restoreQueuedMessageToComposer(message: QueuedUserMessage): void {
    const draft = queuedMessageDraft(message);
    attachmentDraftGeneration += 1;
    promptText = draft.text;
    promptAttachments = draft.attachments;
  }

  function prepareTranscriptAttachment(attachment: Attachment): Promise<void> {
    if (attachment.deferredImageId && !attachment.dataUrl) {
      const requestClient = client;
      const sessionId = activeSessionId;
      if (!requestClient || !sessionId) return Promise.resolve();
      const key = `${sessionId}\0${attachment.deferredImageId}`;
      const existingImage = preparingDeferredImages.get(key);
      if (existingImage) return existingImage;
      const pendingImage = requestClient.sessionImage(sessionId, attachment.deferredImageId)
        .then((image) => {
          if (requestClient !== client) return;
          const current = transcriptBySessionId.get(sessionId) ?? (sessionId === activeSessionId ? transcript : undefined);
          if (!current) return;
          const hydrated = hydrateTranscriptAttachment(
            current,
            attachment.id,
            `data:${image.mimeType};base64,${image.data}`,
            image.mimeType,
          );
          transcriptBySessionId.set(sessionId, hydrated);
          if (sessionId === activeSessionId) transcript = hydrated;
        })
        .finally(() => {
          if (preparingDeferredImages.get(key) === pendingImage) preparingDeferredImages.delete(key);
        });
      preparingDeferredImages.set(key, pendingImage);
      return pendingImage;
    }
    const path = attachment.path;
    if (!path || attachment.dataUrl || registeredAttachmentPaths.has(path)) return Promise.resolve();
    const existing = preparingAttachmentPaths.get(path);
    if (existing) return existing;
    const pending = invoke<AttachmentFile[]>("inspect_attachments", { paths: [path] })
      .then(() => {
        registeredAttachmentPaths.add(path);
      })
      .finally(() => {
        if (preparingAttachmentPaths.get(path) === pending) preparingAttachmentPaths.delete(path);
      });
    preparingAttachmentPaths.set(path, pending);
    return pending;
  }

  function ensureSessionRuntime(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
  ): Promise<void> {
    if (runtimeReadySessionIds.has(sessionId)) {
      if (sessionId === activeSessionId) activeSessionRuntimeReady = true;
      if (!queueItemsBySession.has(sessionId)) void refreshQueueState(sessionId);
      return Promise.resolve();
    }
    const existing = runtimeLoadsBySessionId.get(sessionId);
    if (existing) return existing;

    const generation = (runtimeLoadGenerations.get(sessionId) ?? 0) + 1;
    runtimeLoadGenerations.set(sessionId, generation);

    const pending = requestClient.loadSession(sessionId, requestWorkspace)
      .then((response) => {
        if (
          requestClient !== client
          || requestWorkspace !== workspace
          || runtimeLoadGenerations.get(sessionId) !== generation
        ) return;
        const options = response.configOptions ?? [];
        runtimeReadySessionIds.add(sessionId);
        configOptionsBySessionId.set(sessionId, options);
        void refreshQueueState(sessionId);
        if (sessionId === activeSessionId) {
          configOptions = options;
          activeSessionRuntimeReady = true;
        }
      })
      .catch((error) => {
        if (
          requestClient === client
          && requestWorkspace === workspace
          && runtimeLoadGenerations.get(sessionId) === generation
          && sessionId === activeSessionId
        ) {
          activeSessionRuntimeReady = false;
          reportError(error);
        }
      })
      .finally(() => {
        if (runtimeLoadsBySessionId.get(sessionId) === pending) runtimeLoadsBySessionId.delete(sessionId);
      });
    runtimeLoadsBySessionId.set(sessionId, pending);
    return pending;
  }

  function markSessionRuntimeReady(sessionId: string, options: SessionConfigOption[]): void {
    runtimeReadySessionIds.add(sessionId);
    configOptionsBySessionId.set(sessionId, options);
    void refreshQueueState(sessionId);
    if (sessionId === activeSessionId) activeSessionRuntimeReady = true;
  }

  function forgetSessionRuntime(sessionId: string): void {
    runtimeLoadGenerations.set(sessionId, (runtimeLoadGenerations.get(sessionId) ?? 0) + 1);
    sessionActivityForgottenAt.set(
      sessionId,
      Math.max(sessionActivityForgottenAt.get(sessionId) ?? 0, Date.now()),
    );
    cancelPendingElicitationForSession(sessionId);
    runtimeReadySessionIds.delete(sessionId);
    runtimeLoadsBySessionId.delete(sessionId);
    configOptionsBySessionId.delete(sessionId);
    configChangeGenerations.set(sessionId, (configChangeGenerations.get(sessionId) ?? 0) + 1);
    if (changingConfigBySessionId.has(sessionId)) {
      const nextChanging = new Map(changingConfigBySessionId);
      nextChanging.delete(sessionId);
      changingConfigBySessionId = nextChanging;
    }
    runtimeStatusGenerationsBySession.delete(sessionId);
    dcpStatsRequestGenerations.set(sessionId, (dcpStatsRequestGenerations.get(sessionId) ?? 0) + 1);
    const statuses = new Map(runtimeStatusBySessionId);
    statuses.delete(sessionId);
    runtimeStatusBySessionId = statuses;
    const refreshing = new Set(modelUsageRefreshSessionIds);
    refreshing.delete(sessionId);
    modelUsageRefreshSessionIds = refreshing;
    const refreshingDcp = new Set(dcpStatsRefreshSessionIds);
    refreshingDcp.delete(sessionId);
    dcpStatsRefreshSessionIds = refreshingDcp;
    const compressing = new Set(dcpCompressionSessionIds);
    compressing.delete(sessionId);
    dcpCompressionSessionIds = compressing;
    if (sessionId === activeSessionId) activeSessionRuntimeReady = false;
  }

  function scheduleSessionPrewarm(
    requestClient: AcpClient,
    requestWorkspace: string,
    sessionIds: readonly string[],
  ): void {
    const generation = ++sessionPrewarmGeneration;
    setTimeout(() => {
      void (async () => {
        let warmed = 0;
        for (const sessionId of sessionIds) {
          if (
            generation !== sessionPrewarmGeneration
            || requestClient !== client
            || requestWorkspace !== workspace
            || warmed >= SESSION_PREWARM_LIMIT
          ) return;
          if (runtimeReadySessionIds.has(sessionId) || runtimeLoadsBySessionId.has(sessionId)) continue;
          await ensureSessionRuntime(requestClient, sessionId, requestWorkspace);
          if (runtimeReadySessionIds.has(sessionId)) warmed += 1;
        }
      })();
    }, 0);
  }

  function beginSessionHistoryLoad(): number {
    sessionHistoryLoading = true;
    return ++sessionHistoryGeneration;
  }

  function cancelSessionHistoryLoad(): void {
    sessionHistoryGeneration += 1;
    sessionHistoryLoading = false;
    loadingToolResults.clear();
  }

  function sessionHistoryIsCurrent(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    generation: number,
  ): boolean {
    return requestClient === client
      && sessionId === activeSessionId
      && requestWorkspace === workspace
      && generation === sessionHistoryGeneration;
  }

  async function hydrateSessionHistory(
    requestClient: AcpClient,
    sessionId: string,
    requestWorkspace: string,
    generation: number,
  ): Promise<void> {
    try {
      const history = await requestClient.sessionHistory(sessionId);
      if (!sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, generation)) return;
      let loadedTranscript = applySessionUpdates(emptyTranscript, history.updates);
      loadedTranscript = markDeferredToolResults(loadedTranscript, history.deferredToolCallIds);

      // A tiny amount of live/local state can be appended while persisted
      // history is loading (notably the local "Forked…" marker). Preserve it
      // behind the hydrated history rather than replacing the whole transcript.
      const currentItems = transcript.items;
      const nextTranscript = currentItems.length === 0
        ? loadedTranscript
        : { items: [...loadedTranscript.items, ...currentItems] };
      transcript = nextTranscript;
      transcriptBySessionId.set(sessionId, nextTranscript);
      scheduleScrollToLatest();
    } catch (error) {
      if (!sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`session history ${sessionId} is unavailable`)) {
        // History and runtime loading start in parallel. A newly-created or
        // otherwise empty-but-valid session can have no persisted history yet
        // while its runtime is still perfectly loadable. Do not race that
        // runtime load by deleting the session just because history answered
        // first; only treat it as a stale legacy record if loading also fails.
        await ensureSessionRuntime(requestClient, sessionId, requestWorkspace);
        if (!sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, generation)) return;
        if (runtimeReadySessionIds.has(sessionId)) {
          transcript = emptyTranscript;
          transcriptBySessionId.set(sessionId, transcript);
          sessionHistoryLoading = false;
          return;
        }

        // Compatibility cleanup for empty Desktop sessions created by older
        // builds before the draft tab became UI-only. They have a mapped id
        // but no persisted Pi history, so restoring them can never succeed.
        cancelSessionHistoryLoad();
        errorMessage = null;
        forgetActiveSession(requestWorkspace);
        sessions = sessions.filter((session) => session.sessionId !== sessionId);
        restoredSessionTabs = restoredSessionTabs?.filter((id) => id !== sessionId) ?? restoredSessionTabs;
        locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((id) => id !== sessionId);
        closedSessionTabs = [...new Set([...closedSessionTabs, sessionId])];
        activeSessionId = null;
        activeSessionRuntimeReady = false;
        transcript = emptyTranscript;
        configOptions = [];
        forgetSessionRuntime(sessionId);
        activateDraftSessionTab({ resetComposer: true });
        void requestClient.deleteSession(sessionId).catch(() => undefined);
        return;
      }
      reportError(error);
    } finally {
      if (sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, generation)) {
        sessionHistoryLoading = false;
      }
    }
  }

  async function loadDeferredToolResult(toolCallId: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    const historyGeneration = sessionHistoryGeneration;
    if (!requestClient || !sessionId) return;
    const key = `${sessionId}\0${toolCallId}`;
    if (loadingToolResults.has(key)) return;
    loadingToolResults.add(key);
    transcript = setToolResultLoading(transcript, toolCallId, true);
    try {
      const update = await requestClient.toolResult(sessionId, toolCallId);
      if (!sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, historyGeneration)) return;
      const nextTranscript = applyDeferredToolResult(transcript, update);
      transcript = nextTranscript;
      transcriptBySessionId.set(sessionId, nextTranscript);
    } catch (error) {
      if (sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, historyGeneration)) {
        transcript = setToolResultLoading(
          transcript,
          toolCallId,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      loadingToolResults.delete(key);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (anyPromptRunning || sessionMutationRunning || tasksSaving || taskActionId) return;
    const selected = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      title: "Choose or create a Pix project folder",
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected !== "string") return;
    await selectWorkspace(selected);
  }

  async function chooseWorkspaceInNewWindow(): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      title: "Choose or create a Pix project folder for a new window",
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected !== "string") return;
    openWorkspaceInNewWindow(selected);
  }

  function persistWindowWorkspace(selected: string): void {
    try {
      if (workspaceFromLocation(window.location.href)) {
        window.history.replaceState(null, "", projectWindowUrl(window.location.href, selected));
      } else {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, selected);
      }
    } catch {
      // A storage or history failure should not prevent opening the project for this run.
    }
  }

  function openWorkspaceInNewWindow(selected: string): void {
    if (!isAbsoluteProjectPath(selected)) return;
    rememberProject(selected);
    const label = `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const projectWindow = new WebviewWindow(label, {
        url: projectWindowRoute(window.location.href, selected),
        title: `Pix Desktop — ${projectName(selected)}`,
        width: 1240,
        height: 820,
        minWidth: 860,
        minHeight: 620,
        resizable: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: new LogicalPosition(8, 16),
      });
      void projectWindow.once("tauri://error", (event) => {
        reportError(new Error(`Could not open project window: ${String(event.payload)}`));
      }).catch(reportError);
    } catch (error) {
      reportError(error);
    }
  }

  async function selectWorkspace(selected: string): Promise<void> {
    if (anyPromptRunning || sessionMutationRunning || tasksSaving || taskActionId) return;
    closeSessionSelector();
    if (!isAbsoluteProjectPath(selected)) {
      errorMessage = "The selected project path is not absolute.";
      return;
    }
    if (selected === workspace) {
      rememberProject(selected);
      void loadDesktopPreferences(selected);
      return;
    }
    if (previewDirty && !window.confirm("Discard unsaved Preview changes and switch projects?")) return;

    operationRunning = true;
    errorMessage = null;
    sessionRefreshGeneration += 1;
    try {
      if (workspace) {
        const windowLabel = getCurrentWindow().label;
        await Promise.allSettled([
          invoke("package_terminal_stop_workspace", { windowLabel, workspace }),
          invoke("idx_operation_stop_workspace", { windowLabel, workspace }),
        ]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") reportError(result.reason);
          }
        });
      }
      await closeWorkspaceSessions();
      workspace = selected;
      sessions = [];
      taskLoadGeneration += 1;
      taskDocument = EMPTY_TASK_DOCUMENT;
      projectDocumentsGeneration += 1;
      projectDocuments = EMPTY_PROJECT_DOCUMENTS;
      todoSnapshots = new Map();
      subagentSnapshots = new Map();
      sessionActivityBySessionId = new Map();
      registrySnapshot = undefined;
      registryActionId = null;
      gitLoadGeneration += 1;
      gitSnapshot = undefined;
      gitLoading = false;
      gitError = null;
      gitActionId = null;
      gitLlmActionId = null;
      gitResolveRunning = false;
      gitDiffPreview = null;
      gitDiffReview = undefined;
      slashCommandsBySession = new Map();
      taskActionId = null;
      taskLoadFailed = false;
      taskSaveError = null;
      restoredSessionTabs = null;
      locallyOpenedSessionTabs = [];
      closedSessionTabs = [];
      transcript = emptyTranscript;
      transcriptBySessionId.clear();
      runtimeReadySessionIds.clear();
      runtimeLoadsBySessionId.clear();
      configOptionsBySessionId.clear();
      sessionPrewarmGeneration += 1;
      activeSessionRuntimeReady = false;
      configOptions = [];
      rememberProject(selected);
      persistWindowWorkspace(selected);
      await Promise.all([
        openWorkspaceSession(),
        loadProjectTasks(selected),
        loadProjectDocuments(selected),
        loadDesktopPreferences(selected),
      ]);
    } catch (error) {
      reportError(error);
    } finally {
      operationRunning = false;
    }
  }

  function rememberProject(path: string): void {
    recentProjects = buildRecentProjects(recentProjects, path);
    try {
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
    } catch {
      // Keep the in-memory recent list usable when storage is unavailable.
    }
    refreshProjectColors(recentProjects);
  }

  function restoreProjects(): void {
    try {
      const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      const validSaved = saved && isAbsoluteProjectPath(saved) ? saved : undefined;
      const windowWorkspace = workspaceFromLocation(window.location.href);
      const initialWorkspace = windowWorkspace ?? validSaved;
      workspace = initialWorkspace ?? "";
      recentProjects = parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY), initialWorkspace);
      savedActiveSessionIds = parseActiveSessionIds(localStorage.getItem(ACTIVE_SESSIONS_STORAGE_KEY));
    } catch {
      workspace = "";
      recentProjects = [];
      savedActiveSessionIds = new Map();
    }
  }

  function refreshProjectColors(paths: readonly string[]): void {
    const generation = ++projectColorLoadGeneration;
    const activePaths = new Set(paths);
    projectColors = new Map([...projectColors].filter(([path]) => activePaths.has(path)));
    for (const projectPath of paths) void loadProjectColor(projectPath, generation);
  }

  async function loadProjectColor(projectPath: string, generation: number): Promise<void> {
    const preview = await invoke<ProjectFilePreview>("read_project_file", {
      workspace: projectPath,
      path: WORKSPACE_CONFIG_PATH,
    }).catch(() => undefined);
    if (generation !== projectColorLoadGeneration || !recentProjects.includes(projectPath)) return;
    const color = projectColorFromWorkspaceConfig(preview?.content);
    const next = new Map(projectColors);
    if (color) next.set(projectPath, color);
    else next.delete(projectPath);
    projectColors = next;
  }

  async function saveProjectColor(color: string | undefined): Promise<string | undefined> {
    if (!workspace) return "Open a project before changing project settings.";
    const requestWorkspace = workspace;
    const generation = ++projectColorSaveGeneration;
    // Any read that started before this save must not repaint the just-saved value.
    projectColorLoadGeneration += 1;
    try {
      const exists = await invoke<boolean>("project_file_exists", {
        workspace: requestWorkspace,
        path: WORKSPACE_CONFIG_PATH,
      });
      if (generation !== projectColorSaveGeneration || workspace !== requestWorkspace) {
        return "The active project changed before settings could be saved.";
      }
      let current = exists
        ? await invoke<ProjectFilePreview>("read_project_file", {
            workspace: requestWorkspace,
            path: WORKSPACE_CONFIG_PATH,
          })
        : undefined;
      if (generation !== projectColorSaveGeneration || workspace !== requestWorkspace) {
        return "The active project changed before settings could be saved.";
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const content = workspaceConfigWithProjectColor(current?.content, color);
        const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>(
          "write_project_workspace_config_if_unchanged",
          {
            workspace: requestWorkspace,
            expectedContent: current?.content ?? null,
            content,
          },
        );
        if (generation !== projectColorSaveGeneration || workspace !== requestWorkspace) return undefined;
        if (result.written && result.document) {
          const savedColor = projectColorFromWorkspaceConfig(result.document.content);
          const next = new Map(projectColors);
          if (savedColor) next.set(requestWorkspace, savedColor);
          else next.delete(requestWorkspace);
          projectColors = next;
          refreshProjectColors(recentProjects);
          return undefined;
        }
        current = result.document ?? undefined;
      }
      return ".pi/workspace.jsonc changed repeatedly while project settings were being saved. Try again.";
    } catch (error) {
      if (generation !== projectColorSaveGeneration || workspace !== requestWorkspace) return undefined;
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function loadDesktopPreferences(projectPath: string): Promise<void> {
    const [globalConfig, projectConfig] = await Promise.all([
      invoke<ProjectFilePreview>("read_home_file", { path: "~/.config/pi/pix.jsonc" }).catch(() => undefined),
      invoke<ProjectFilePreview>("read_project_file", {
        workspace: projectPath,
        path: ".pi/pix.jsonc",
      }).catch(() => undefined),
    ]);
    if (workspace !== projectPath) return;
    externalEditor = resolveDesktopPreferences(globalConfig?.content, projectConfig?.content).externalEditor;
  }

  async function listProjectDirectory(path: string): Promise<ProjectTreeEntry[]> {
    if (!workspace) return [];
    const requestWorkspace = workspace;
    const entries = await invoke<ProjectTreeEntry[]>("list_project_directory", {
      workspace: requestWorkspace,
      path: path || null,
    });
    return workspace === requestWorkspace ? entries : [];
  }

  async function openInExternalEditor(path?: string): Promise<void> {
    if (!workspace) return;
    const requestWorkspace = workspace;
    try {
      await loadDesktopPreferences(requestWorkspace);
      if (workspace !== requestWorkspace) return;
      await invoke("open_in_external_editor", {
        workspace: requestWorkspace,
        path: path || null,
        editor: externalEditor,
      });
    } catch (error) {
      if (workspace === requestWorkspace) reportError(error);
    }
  }

  async function refreshGit(): Promise<void> {
    if (!workspace) return;
    const requestWorkspace = workspace;
    const generation = ++gitLoadGeneration;
    gitLoading = true;
    gitError = null;
    try {
      const snapshot = await invoke<GitSnapshot>("git_status", { workspace: requestWorkspace });
      if (generation !== gitLoadGeneration || workspace !== requestWorkspace) return;
      gitSnapshot = snapshot;
    } catch (error) {
      if (generation !== gitLoadGeneration || workspace !== requestWorkspace) return;
      gitSnapshot = undefined;
      gitError = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === gitLoadGeneration && workspace === requestWorkspace) gitLoading = false;
    }
  }

  async function runGitMutation(
    actionId: string,
    command: string,
    payload: Record<string, unknown> = {},
    options: { reloadProject?: boolean } = {},
  ): Promise<boolean> {
    if (!workspace || gitActionId !== null) return false;
    if (
      options.reloadProject
      && previewDirty
      && !window.confirm("Discard unsaved Preview changes and reload the project?")
    ) return false;
    const requestWorkspace = workspace;
    gitActionId = actionId;
    gitError = null;
    try {
      await invoke(command, { workspace: requestWorkspace, ...payload });
      if (workspace !== requestWorkspace) return false;
      if (options.reloadProject) {
        closePreview();
        gitDiffPreview = null;
        gitDiffReview = undefined;
        await Promise.all([
          loadProjectTasks(requestWorkspace),
          loadProjectDocuments(requestWorkspace),
          loadDesktopPreferences(requestWorkspace),
        ]);
      }
      await refreshGit();
      return workspace === requestWorkspace;
    } catch (error) {
      if (workspace === requestWorkspace) gitError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (workspace === requestWorkspace && gitActionId === actionId) gitActionId = null;
    }
  }

  function stageGitPath(path?: string): void {
    void runGitMutation(path ? `stage:${path}` : "stage:all", "git_stage", { path: path ?? null });
  }

  function unstageGitPath(path?: string): void {
    void runGitMutation(path ? `unstage:${path}` : "unstage:all", "git_unstage", { path: path ?? null });
  }

  async function commitGit(message: string): Promise<boolean> {
    return runGitMutation("commit", "git_commit", { message });
  }

  function pushGit(): void {
    void runGitMutation("push", "git_push");
  }

  function switchGitBranch(branch: string): void {
    void runGitMutation(`switch:${branch}`, "git_switch_branch", { branch }, { reloadProject: true });
  }

  function createGitBranch(branch: string): void {
    void runGitMutation(`create:${branch}`, "git_create_branch", { branch }, { reloadProject: true });
  }

  async function requestGitDiff(path: string | undefined, scope: GitDiffScope): Promise<GitDiff | undefined> {
    if (!workspace) return undefined;
    const requestWorkspace = workspace;
    try {
      const diff = await invoke<GitDiff>("git_diff", {
        workspace: requestWorkspace,
        path: path ?? null,
        scope,
      });
      return workspace === requestWorkspace ? diff : undefined;
    } catch (error) {
      if (workspace === requestWorkspace) gitError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  async function openGitDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    if (gitActionId !== null) return;
    const actionId = `diff:${scope}:${path ?? "all"}`;
    gitActionId = actionId;
    gitError = null;
    try {
      const diff = await requestGitDiff(path, scope);
      if (!diff) return;
      gitDiffPreview = diff;
      gitDiffReview = undefined;
      activeWorkspaceEditor = "git-diff";
    } finally {
      if (gitActionId === actionId) gitActionId = null;
    }
  }

  async function reviewGitDiff(path: string | undefined, scope: GitDiffScope): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId || !requestWorkspace || !activeSessionRuntimeReady || gitLlmActionId !== null) return;
    const actionId = `review:${path ? `${scope}:${path}` : "all"}`;
    gitLlmActionId = actionId;
    gitError = null;
    try {
      const current = gitDiffPreview;
      const diff = current && current.path === path && current.scope === scope
        ? current
        : await requestGitDiff(path, scope);
      if (!diff || requestClient !== client || requestWorkspace !== workspace || sessionId !== activeSessionId) return;
      gitDiffPreview = diff;
      gitDiffReview = undefined;
      activeWorkspaceEditor = "git-diff";
      if (!diff.content.trim()) {
        gitDiffReview = "No diff to review.";
        return;
      }
      const review = await requestClient.gitAssist(sessionId, "review", gitDiffForLlm(diff));
      if (requestClient !== client || requestWorkspace !== workspace || sessionId !== activeSessionId) return;
      if (gitDiffPreview?.path !== diff.path || gitDiffPreview?.scope !== diff.scope) return;
      gitDiffReview = review;
    } catch (error) {
      if (requestClient === client && requestWorkspace === workspace && sessionId === activeSessionId) {
        const detail = error instanceof Error ? error.message : String(error);
        if (gitDiffPreview?.path === path && gitDiffPreview?.scope === scope) {
          gitDiffReview = `### Review failed\n\n${detail}`;
        }
      }
    } finally {
      if (gitLlmActionId === actionId) gitLlmActionId = null;
    }
  }

  async function generateGitCommitMessage(): Promise<string | undefined> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId || !requestWorkspace || !activeSessionRuntimeReady || gitLlmActionId !== null) return undefined;
    const actionId = "commit-message";
    gitLlmActionId = actionId;
    gitError = null;
    try {
      const diff = await requestGitDiff(undefined, "staged");
      if (!diff || requestClient !== client || requestWorkspace !== workspace || sessionId !== activeSessionId) return undefined;
      if (!diff.content.trim()) {
        gitError = "There are no staged changes to describe.";
        return undefined;
      }
      return await requestClient.gitAssist(sessionId, "commit-message", gitDiffForLlm(diff));
    } catch (error) {
      if (requestClient === client && requestWorkspace === workspace && sessionId === activeSessionId) {
        gitError = error instanceof Error ? error.message : String(error);
      }
      return undefined;
    } finally {
      if (gitLlmActionId === actionId) gitLlmActionId = null;
    }
  }

  async function resolveGitReviewInNewSession(): Promise<void> {
    const requestClient = client;
    const requestWorkspace = workspace;
    const diff = gitDiffPreview;
    const review = gitDiffReview;
    if (
      !requestClient
      || !requestWorkspace
      || !diff
      || !gitReviewHasFindings(review)
      || !review
      || gitResolveRunning
      || operationRunning
      || status !== "ready"
    ) return;

    const prompt = gitReviewResolutionPrompt(diff, review);
    gitResolveRunning = true;
    gitError = null;
    let createdSessionId: string | undefined;
    try {
      const created = await requestClient.newSession(requestWorkspace);
      createdSessionId = created.sessionId;
      if (requestClient !== client || requestWorkspace !== workspace) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        return;
      }

      // Warm the new runtime before making it the active tab. If startup fails,
      // the user's current conversation and review popup remain untouched.
      await ensureSessionRuntime(requestClient, created.sessionId, requestWorkspace);
      if (requestClient !== client || requestWorkspace !== workspace) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        forgetSessionRuntime(created.sessionId);
        return;
      }
      if (!runtimeReadySessionIds.has(created.sessionId)) {
        await requestClient.closeSession(created.sessionId).catch(() => undefined);
        forgetSessionRuntime(created.sessionId);
        gitError = "Could not start a new session for resolving the code-review findings.";
        return;
      }

      if (activeSessionId) transcriptBySessionId.set(activeSessionId, transcript);
      ensureProvisionalSession(created.sessionId, requestWorkspace);
      showSessionTab(created.sessionId);
      activeSessionId = created.sessionId;
      rememberActiveSession(requestWorkspace, created.sessionId);
      transcript = emptyTranscript;
      configOptions = configOptionsBySessionId.get(created.sessionId) ?? [];
      activeSessionRuntimeReady = true;

      const transcriptMessageId = `local:${++localMessageId}`;
      transcript = appendLocalUserMessage(
        transcript,
        prompt,
        transcriptMessageId,
        [],
      );
      transcriptBySessionId.set(created.sessionId, transcript);

      const run = runPromptRequest(requestClient, created.sessionId, [{ type: "text", text: prompt }], [], transcriptMessageId);
      gitDiffPreview = null;
      gitDiffReview = undefined;
      activeWorkspaceEditor = "conversation";
      void scrollToLatest();
      void refreshSessions();
      void run
        .then(() => refreshSessions())
        .catch((error) => {
          if (requestClient === client && requestWorkspace === workspace) reportError(error);
        });
    } catch (error) {
      if (createdSessionId) {
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
        forgetSessionRuntime(createdSessionId);
      }
      if (requestClient === client && requestWorkspace === workspace) {
        gitError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestClient === client && requestWorkspace === workspace) gitResolveRunning = false;
    }
  }

  async function loadProjectDocuments(projectPath: string): Promise<void> {
    const generation = ++projectDocumentsGeneration;
    try {
      const snapshot = await invoke<ProjectDocumentsSnapshot>("list_project_documents", {
        workspace: projectPath,
      });
      if (generation !== projectDocumentsGeneration || workspace !== projectPath) return;
      projectDocuments = snapshot;
    } catch (error) {
      if (generation === projectDocumentsGeneration && workspace === projectPath) reportError(error);
    }
  }

  function openProjectDocument(path: string, exists = true): void {
    if (!workspace || !isEditableProjectMarkdown(path)) return;
    if (exists) {
      void openProjectFile(path);
      return;
    }
    if (path === PROJECT_TODO_PATH) {
      showPreview({ kind: "file", file: { path, content: "" } }, "replace");
    }
  }

  async function saveProjectMarkdown(path: string, content: string): Promise<boolean> {
    if (!workspace || !isEditableProjectMarkdown(path)) return false;
    const requestWorkspace = workspace;
    errorMessage = null;
    try {
      const saved = await invoke<ProjectFilePreview>("write_project_markdown", {
        workspace: requestWorkspace,
        path,
        content,
      });
      if (workspace !== requestWorkspace) return false;
      const current = currentPreview(previewHistory);
      if (current?.kind === "file" && current.file.path === path) {
        previewHistory = replaceCurrentPreview(previewHistory, { ...current, file: saved });
      }
      void loadProjectDocuments(requestWorkspace);
      if (registrySnapshot && activeSessionRuntimeReady && !operationRunning) refreshRegistry();
      return true;
    } catch (error) {
      if (workspace === requestWorkspace) reportError(error);
      return false;
    }
  }

  async function loadProjectTasks(projectPath: string): Promise<void> {
    const generation = ++taskLoadGeneration;
    tasksLoading = true;
    taskLoadFailed = false;
    taskSaveError = null;
    try {
      const value = await invoke<unknown>("read_project_tasks", { workspace: projectPath });
      if (generation !== taskLoadGeneration || workspace !== projectPath) return;
      taskDocument = parseTaskDocument(value);
    } catch (error) {
      if (generation === taskLoadGeneration && workspace === projectPath) {
        taskLoadFailed = true;
        reportError(error);
      }
    } finally {
      if (generation === taskLoadGeneration && workspace === projectPath) tasksLoading = false;
    }
  }

  async function saveProjectTasks(next: ProjectTaskDocument): Promise<boolean> {
    if (!workspace || tasksSaving || taskLoadFailed) return false;
    const requestWorkspace = workspace;
    const previous = taskDocument;
    let validated: ProjectTaskDocument;
    try {
      validated = parseTaskDocument(next);
    } catch (error) {
      reportError(error);
      return false;
    }
    taskDocument = validated;
    tasksSaving = true;
    taskSaveError = null;
    try {
      await invoke("write_project_tasks", { workspace: requestWorkspace, document: validated });
      return workspace === requestWorkspace;
    } catch (error) {
      if (workspace === requestWorkspace) taskDocument = previous;
      if (workspace === requestWorkspace) {
        taskSaveError = error instanceof Error ? error.message : String(error);
      }
      reportError(error);
      return false;
    } finally {
      tasksSaving = false;
    }
  }

  function createProjectTask(draft: ProjectTaskDraft): void {
    const title = draft.title.trim();
    if (!title) return;
    const description = draft.description?.trim();
    const timestamp = new Date().toISOString();
    const task: ProjectTask = {
      id: newProjectTaskId(),
      title,
      ...(description ? { description } : {}),
      type: draft.type,
      status: "todo",
      priority: "medium",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    void saveProjectTasks({ ...taskDocument, tasks: [task, ...taskDocument.tasks] });
  }

  function updateProjectTask(taskId: string, draft: ProjectTaskDraft): void {
    const title = draft.title.trim();
    const description = draft.description?.trim();
    if (!title && !description) return;
    const timestamp = new Date().toISOString();
    void saveProjectTasks({
      ...taskDocument,
      tasks: taskDocument.tasks.map((task) => task.id === taskId
        ? {
            ...task,
            title,
            ...(description ? { description } : { description: undefined }),
            type: draft.type,
            updatedAt: timestamp,
          }
        : task),
    });
  }

  async function createProjectTaskFromComposer(): Promise<void> {
    if (!workspace || tasksSaving || taskLoadFailed) return;
    const initialDraftKey = attachmentDraftKey;
    await waitForAttachmentDraftSettled(initialDraftKey);
    if (initialDraftKey !== attachmentDraftKey || !workspace || tasksSaving || taskLoadFailed) return;

    const requestWorkspace = workspace;
    const requestClient = client;
    const requestSessionId = activeSessionId;
    const draftKey = attachmentDraftKey;
    const draftGeneration = attachmentDraftGeneration;
    const text = promptText;
    const attachments = promptAttachments;
    let storedAttachments: Attachment[];
    try {
      storedAttachments = await materializeComposerTaskAttachments(
        attachments,
        requestWorkspace,
        requestClient,
        requestSessionId,
      );
    } catch (error) {
      reportError(error);
      return;
    }
    if (workspace !== requestWorkspace || tasksSaving || taskLoadFailed) return;
    const timestamp = new Date().toISOString();
    const task = projectTaskFromComposerDraft(text, storedAttachments, newProjectTaskId(), timestamp);
    if (!task) return;

    const saved = await saveProjectTasks({ ...taskDocument, tasks: [task, ...taskDocument.tasks] });
    if (!saved || workspace !== requestWorkspace) return;
    await workspaceSidebar?.openTasksPanel(task.id);

    if (
      activeSessionId === requestSessionId
      && attachmentDraftKey === draftKey
      && attachmentDraftGeneration === draftGeneration
      && promptText === text
      && promptAttachments === attachments
    ) {
      promptText = "";
      invalidateAttachmentDraft();
    }
  }

  function newProjectTaskId(): string {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function updateProjectTaskStatus(taskId: string, status: ProjectTaskStatus): void {
    if (tasksSaving || taskLoadFailed) return;
    const timestamp = new Date().toISOString();
    void saveProjectTasks({
      ...taskDocument,
      tasks: taskDocument.tasks.map((task) => task.id === taskId
        ? { ...task, status, updatedAt: timestamp }
        : task),
    });
  }

  function reorderProjectTask(
    taskId: string,
    targetType: ProjectTaskType,
    targetTaskId: string | null,
    position: ProjectTaskDropPosition,
  ): void {
    if (tasksSaving || taskLoadFailed) return;
    const nextTasks = moveProjectTask(
      taskDocument.tasks,
      taskId,
      targetType,
      targetTaskId,
      position,
      new Date().toISOString(),
    );
    if (!nextTasks) return;
    void saveProjectTasks({ ...taskDocument, tasks: nextTasks });
  }

  function deleteProjectTask(taskId: string): void {
    void saveProjectTasks({
      ...taskDocument,
      tasks: taskDocument.tasks.filter((task) => task.id !== taskId),
    });
  }

  function rememberActiveSession(projectPath: string, sessionId: string): void {
    savedActiveSessionIds.set(projectPath, sessionId);
    persistActiveSessionIds();
  }

  function forgetActiveSession(projectPath: string): void {
    if (!savedActiveSessionIds.delete(projectPath)) return;
    persistActiveSessionIds();
  }

  function persistActiveSessionIds(): void {
    try {
      localStorage.setItem(ACTIVE_SESSIONS_STORAGE_KEY, serializeActiveSessionIds(savedActiveSessionIds));
    } catch {
      // Persistence failure should not prevent sessions from working for this run.
    }
  }

  function closeProjectSelector(): void {
    workspaceSidebar?.closeProjectSwitcher();
  }

  function prepareProjectSwitcher(): void {
    closeSessionSelector();
    refreshProjectColors(recentProjects);
  }

  async function refreshSessions(): Promise<void> {
    if (!client || !workspace) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    const existing = sessionRefreshRequest;
    if (existing?.client === requestClient && existing.workspace === requestWorkspace) {
      return existing.promise;
    }
    const generation = ++sessionRefreshGeneration;
    const promise = requestClient.listSessions(requestWorkspace)
      .then((response) => {
        if (generation !== sessionRefreshGeneration || client !== requestClient || workspace !== requestWorkspace) return;
        sessions = response.sessions;
        restoredSessionTabs = mergeRestoredSessionTabs(
          restoredSessionTabs,
          restoredTabSessionIds(response),
          locallyOpenedSessionTabs,
          closedSessionTabs,
        );
      })
      .catch((error) => {
        if (generation !== sessionRefreshGeneration || client !== requestClient || workspace !== requestWorkspace) return;
        reportError(error);
      })
      .finally(() => {
        if (sessionRefreshRequest?.promise === promise) sessionRefreshRequest = null;
      });
    sessionRefreshRequest = { client: requestClient, workspace: requestWorkspace, promise };
    return promise;
  }

  async function openWorkspaceSession(): Promise<void> {
    if (!client || !workspace) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    const generation = ++sessionRefreshGeneration;
    operationRunning = true;
    errorMessage = null;
    try {
      const response = await requestClient.listSessions(requestWorkspace);
      if (generation !== sessionRefreshGeneration || client !== requestClient || workspace !== requestWorkspace) return;
      sessions = response.sessions;
      restoredSessionTabs = mergeRestoredSessionTabs(
        restoredSessionTabs,
        restoredTabSessionIds(response),
        locallyOpenedSessionTabs,
        closedSessionTabs,
      );

      const desktopSessionId = savedActiveSessionIds.get(requestWorkspace) ?? null;
      const sessionId = startupSessionId(response, desktopSessionId);
      if (desktopSessionId && desktopSessionId !== sessionId) forgetActiveSession(requestWorkspace);

      transcript = emptyTranscript;
      configOptions = [];
      activeSessionRuntimeReady = false;
      if (sessionId) {
        draftSessionTabOpen = false;
        draftSessionTabActive = false;
        draftSessionTabTouched = false;
        activeSessionId = sessionId;
        configOptions = configOptionsBySessionId.get(sessionId) ?? [];
        activeSessionRuntimeReady = runtimeReadySessionIds.has(sessionId);
        const historyGeneration = beginSessionHistoryLoad();
        void hydrateSessionHistory(requestClient, sessionId, requestWorkspace, historyGeneration);
        showSessionTab(sessionId);
        rememberActiveSession(requestWorkspace, sessionId);
        const runtime = ensureSessionRuntime(requestClient, sessionId, requestWorkspace);
        void runtime.then(() => {
          if (runtimeReadySessionIds.has(sessionId)) {
            scheduleSessionPrewarm(
              requestClient,
              requestWorkspace,
              restoredSessionTabs ?? response.sessions.map((session) => session.sessionId),
            );
          }
        });
        return;
      }

      activateDraftSessionTab({ resetComposer: true });
    } catch (error) {
      if (client !== requestClient || workspace !== requestWorkspace) return;
      cancelSessionHistoryLoad();
      activeSessionId = null;
      transcript = emptyTranscript;
      reportError(error);
    } finally {
      if (client === requestClient && workspace === requestWorkspace) operationRunning = false;
    }
  }

  function invalidateDraftSessionMaterialization(): void {
    draftSessionMaterializationGeneration += 1;
    draftSessionMaterializing = false;
  }

  function activateDraftSessionTab(options: { resetComposer?: boolean } = {}): void {
    if (!workspace || status !== "ready") return;
    closeProjectSelector();
    closeSessionSelector();
    if (options.resetComposer) invalidateDraftSessionMaterialization();
    if (activeSessionId) transcriptBySessionId.set(activeSessionId, transcript);
    cancelSessionHistoryLoad();
    activeSessionId = null;
    activeSessionRuntimeReady = false;
    transcript = emptyTranscript;
    configOptions = [];
    draftSessionTabOpen = true;
    draftSessionTabActive = true;
    if (options.resetComposer) {
      draftSessionTabTouched = false;
      promptText = "";
      invalidateAttachmentDraft();
    }
  }

  async function openSessionStartTab(): Promise<void> {
    if (!canUseSession) return;
    if (draftSessionTabOpen) {
      activateDraftSessionTab();
      await tick();
      await promptComposer?.focus();
      return;
    }
    activateDraftSessionTab({ resetComposer: true });
    await tick();
    await promptComposer?.focus();
  }

  async function materializeDraftSession(): Promise<string | null> {
    if (!draftSessionTabActive) return activeSessionId;
    if (!client || !workspace || status !== "ready" || operationRunning || draftSessionMaterializing) return null;
    const requestClient = client;
    const requestWorkspace = workspace;
    const generation = ++draftSessionMaterializationGeneration;
    let createdSessionId: string | null = null;
    draftSessionMaterializing = true;
    errorMessage = null;

    const abandoned = (): boolean => (
      requestClient !== client
      || requestWorkspace !== workspace
      || generation !== draftSessionMaterializationGeneration
      || !draftSessionTabActive
    );
    const discardCreatedSession = (sessionId: string): void => {
      // Invalidate any local runtime completion immediately, but do not keep
      // the UI disabled while ACP finishes tearing down a background spawn.
      forgetSessionRuntime(sessionId);
      void requestClient.closeSession(sessionId).catch(() => undefined);
    };

    try {
      const created = await requestClient.newSession(requestWorkspace);
      createdSessionId = created.sessionId;
      if (abandoned()) {
        discardCreatedSession(created.sessionId);
        return null;
      }
      const loaded = await requestClient.loadSession(created.sessionId, requestWorkspace);
      if (abandoned()) {
        discardCreatedSession(created.sessionId);
        return null;
      }

      ensureProvisionalSession(created.sessionId, requestWorkspace);
      showSessionTab(created.sessionId);
      // Retarget the existing unsent attachment draft to the real session so
      // the session-id transition does not clear attachments before submit.
      previousAttachmentDraftKey = `${requestWorkspace}\0${created.sessionId}`;
      activeSessionId = created.sessionId;
      draftSessionTabOpen = false;
      draftSessionTabActive = false;
      draftSessionTabTouched = false;
      transcript = emptyTranscript;
      transcriptBySessionId.set(created.sessionId, transcript);
      const options = loaded.configOptions ?? created.configOptions ?? [];
      configOptions = options;
      markSessionRuntimeReady(created.sessionId, options);
      rememberActiveSession(requestWorkspace, created.sessionId);
      return created.sessionId;
    } catch (error) {
      if (createdSessionId) {
        discardCreatedSession(createdSessionId);
      }
      if (
        requestClient === client
        && requestWorkspace === workspace
        && generation === draftSessionMaterializationGeneration
        && draftSessionTabActive
      ) reportError(error);
      return null;
    } finally {
      if (generation === draftSessionMaterializationGeneration) draftSessionMaterializing = false;
    }
  }

  const KNOWLEDGE_REFRESH_PROMPT = [
    "Update the project knowledge base to match the current repository.",
    "Audit IDX knowledge status, discover new or changed knowledge documents, and review current working-tree impact.",
    "For every stale, unverified, uncovered, or newly discovered current/proposed contract, read the primary source and verify it against relevant implementation and tests before changing knowledge metadata.",
    "Update existing primary specs when behavior changed, or create a focused primary spec when no current contract exists. Record, relate, and verify metadata only after semantic evidence review.",
    "Finish by re-running knowledge status/audit and aim for needs review = 0, unverified = 0, uncovered active as-is = 0, and new/changed candidates = 0 when the evidence supports it.",
    "Do not add or preserve legacy compatibility unless current product requirements explicitly demand it. Treat legacy behavior found in active code/specs as a mismatch to investigate, not as automatically supported behavior.",
    "Do not silence unresolved path references by deleting useful runtime or project-local contract paths; fix only genuinely invalid references and explain the rest.",
  ].join("\n\n");

  async function refreshKnowledgeBaseInNewSession(): Promise<void> {
    if (!client || !canUseSession) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    errorMessage = null;
    let createdSessionId: string | undefined;
    let activated = false;
    try {
      const response = await requestClient.newSession(requestWorkspace);
      createdSessionId = response.sessionId;
      if (requestClient !== client || requestWorkspace !== workspace) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        return;
      }

      await ensureSessionRuntime(requestClient, response.sessionId, requestWorkspace);
      if (requestClient !== client || requestWorkspace !== workspace) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        forgetSessionRuntime(response.sessionId);
        return;
      }
      if (!runtimeReadySessionIds.has(response.sessionId)) {
        await requestClient.closeSession(response.sessionId).catch(() => undefined);
        forgetSessionRuntime(response.sessionId);
        errorMessage = "Could not start a new session for updating the knowledge base.";
        return;
      }

      if (activeSessionId) transcriptBySessionId.set(activeSessionId, transcript);
      ensureProvisionalSession(response.sessionId, requestWorkspace);
      showSessionTab(response.sessionId);
      activeSessionId = response.sessionId;
      rememberActiveSession(requestWorkspace, response.sessionId);
      transcript = emptyTranscript;
      configOptions = configOptionsBySessionId.get(response.sessionId) ?? [];
      activeSessionRuntimeReady = true;
      activated = true;

      operationRunning = false;
      const transcriptMessageId = `local:${++localMessageId}`;
      transcript = appendLocalUserMessage(
        transcript,
        KNOWLEDGE_REFRESH_PROMPT,
        transcriptMessageId,
        [],
      );
      transcriptBySessionId.set(response.sessionId, transcript);
      await scrollToLatest();
      await runPromptRequest(requestClient, response.sessionId, [{ type: "text", text: KNOWLEDGE_REFRESH_PROMPT }], [], transcriptMessageId);
      void refreshSessions();
    } catch (error) {
      if (createdSessionId && !activated) {
        await requestClient.closeSession(createdSessionId).catch(() => undefined);
        forgetSessionRuntime(createdSessionId);
      }
      if (requestClient === client && requestWorkspace === workspace) reportError(error);
    } finally {
      if (requestClient === client && requestWorkspace === workspace) operationRunning = false;
    }
  }

  async function runProjectTask(task: ProjectTask): Promise<void> {
    if (task.sessionId) {
      await openProjectTaskSession(task);
      return;
    }
    if (!client || !canUseSession || tasksSaving || taskActionId) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    taskActionId = task.id;
    errorMessage = null;
    let taskSessionId: string | undefined;
    try {
      const taskPrompt = projectTaskPromptDraft(task);
      await Promise.all(taskPrompt.attachments.map((attachment) => prepareTranscriptAttachment(attachment)));
      const payload = await buildPromptPayload(taskPrompt.text, taskPrompt.attachments);
      if (client !== requestClient || workspace !== requestWorkspace) return;
      const response = await requestClient.newSession(requestWorkspace);
      taskSessionId = response.sessionId;
      if (client !== requestClient || workspace !== requestWorkspace) return;
      ensureProvisionalSession(response.sessionId, requestWorkspace);
      showSessionTab(response.sessionId);
      activeSessionId = response.sessionId;
      rememberActiveSession(requestWorkspace, response.sessionId);
      transcript = emptyTranscript;
      transcriptBySessionId.set(response.sessionId, transcript);
      configOptions = [];
      activeSessionRuntimeReady = false;
      await ensureSessionRuntime(requestClient, response.sessionId, requestWorkspace);
      if (!runtimeReadySessionIds.has(response.sessionId)) return;
      void refreshSessions();

      const timestamp = new Date().toISOString();
      const saved = await saveProjectTasks({
        ...taskDocument,
        tasks: taskDocument.tasks.map((candidate) => candidate.id === task.id
          ? {
              ...candidate,
              status: candidate.status === "done" ? "done" : "in-progress",
              sessionId: response.sessionId,
              updatedAt: timestamp,
            }
          : candidate),
      });
      if (!saved || client !== requestClient || workspace !== requestWorkspace) return;

      operationRunning = false;
      const transcriptMessageId = `local:${++localMessageId}`;
      transcript = appendLocalUserMessage(
        transcript,
        taskPrompt.text,
        transcriptMessageId,
        taskPrompt.attachments,
      );
      transcriptBySessionId.set(response.sessionId, transcript);
      await scrollToLatest();
      await runPromptRequest(requestClient, response.sessionId, payload.blocks, payload.fileImages, transcriptMessageId);
      void refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      if (workspace === requestWorkspace) {
        operationRunning = false;
        taskActionId = null;
      }
    }
  }

  async function openProjectTaskSession(task: ProjectTask): Promise<void> {
    if (!task.sessionId || taskActionId || sessionMutationRunning) return;
    if (task.sessionId === activeSessionId) return;
    taskActionId = task.id;
    try {
      await loadSession(task.sessionId);
    } finally {
      taskActionId = null;
    }
  }

  async function loadSession(sessionId: string): Promise<void> {
    if (!client || !canUseSession || sessionId === activeSessionId) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    closeProjectSelector();
    closeSessionSelector();
    errorMessage = null;
    if (activeSessionId) transcriptBySessionId.set(activeSessionId, transcript);
    draftSessionTabActive = false;
    closedSessionTabs = closedSessionTabs.filter((closedId) => closedId !== sessionId);
    activeSessionId = sessionId;
    const cachedTranscript = transcriptBySessionId.get(sessionId);
    transcript = cachedTranscript ?? emptyTranscript;
    configOptions = configOptionsBySessionId.get(sessionId) ?? [];
    activeSessionRuntimeReady = runtimeReadySessionIds.has(sessionId);
    if (cachedTranscript) {
      cancelSessionHistoryLoad();
    } else {
      const historyGeneration = beginSessionHistoryLoad();
      void hydrateSessionHistory(requestClient, sessionId, requestWorkspace, historyGeneration);
    }
    showSessionTab(sessionId);
    rememberActiveSession(requestWorkspace, sessionId);
    const runtime = ensureSessionRuntime(requestClient, sessionId, requestWorkspace);
    void runtime.then(() => {
      if (runtimeReadySessionIds.has(sessionId)) {
        scheduleSessionPrewarm(
          requestClient,
          requestWorkspace,
          tabSessions.map((session) => session.sessionId),
        );
      }
    });
  }

  async function replaceCurrentTabWithSession(sessionId: string): Promise<void> {
    const requestClient = client;
    const requestWorkspace = workspace;
    const sourceSessionId = activeSessionId;
    if (!requestClient || !requestWorkspace || status !== "ready" || sessionMutationRunning || sessionId === sourceSessionId) {
      if (sessionId === sourceSessionId) closeSessionSelector();
      return;
    }
    if (sourceSessionId && runningSessionIds.has(sourceSessionId)) {
      reportError(new Error("Cannot replace the current tab while its session is running."));
      return;
    }

    closeProjectSelector();
    closeSessionSelector();
    sessionPrewarmGeneration += 1;
    operationRunning = true;
    errorMessage = null;
    try {
      await ensureSessionRuntime(requestClient, sessionId, requestWorkspace);
      if (
        requestClient !== client
        || requestWorkspace !== workspace
        || !runtimeReadySessionIds.has(sessionId)
      ) {
        if (requestClient === client && requestWorkspace === workspace) {
          throw new Error("Could not load the selected session.");
        }
        return;
      }

      if (sourceSessionId) {
        transcriptBySessionId.set(sourceSessionId, transcript);
        await requestClient.closeSession(sourceSessionId);
        if (requestClient !== client || requestWorkspace !== workspace || activeSessionId !== sourceSessionId) return;
        forgetSessionRuntime(sourceSessionId);
        clearSessionActivity(sourceSessionId);
      }

      const nextTabs = replaceSessionTab(
        restoredSessionTabs,
        locallyOpenedSessionTabs,
        closedSessionTabs,
        sourceSessionId,
        sessionId,
      );
      restoredSessionTabs = nextTabs.restoredIds;
      locallyOpenedSessionTabs = nextTabs.locallyOpenedIds;
      closedSessionTabs = nextTabs.closedIds;

      cancelSessionHistoryLoad();
      activeSessionId = sessionId;
      const cachedTranscript = transcriptBySessionId.get(sessionId);
      transcript = cachedTranscript ?? emptyTranscript;
      configOptions = configOptionsBySessionId.get(sessionId) ?? [];
      activeSessionRuntimeReady = true;
      if (!cachedTranscript) {
        const historyGeneration = beginSessionHistoryLoad();
        void hydrateSessionHistory(requestClient, sessionId, requestWorkspace, historyGeneration);
      }
      rememberActiveSession(requestWorkspace, sessionId);
      void refreshQueueState(sessionId);
      void refreshSessions();
      scheduleSessionPrewarm(
        requestClient,
        requestWorkspace,
        tabSessions.map((session) => session.sessionId),
      );
    } catch (error) {
      if (requestClient === client && requestWorkspace === workspace) reportError(error);
    } finally {
      if (requestClient === client && requestWorkspace === workspace) operationRunning = false;
    }
  }

  async function closeWorkspaceSessions(): Promise<void> {
    sessionPrewarmGeneration += 1;
    invalidateDraftSessionMaterialization();
    draftSessionTabOpen = false;
    draftSessionTabActive = false;
    draftSessionTabTouched = false;
    const sessionIds = [...new Set([
      ...tabSessions.map((session) => session.sessionId),
      ...(activeSessionId ? [activeSessionId] : []),
    ])];
    cancelSessionHistoryLoad();
    activeSessionId = null;
    activeSessionRuntimeReady = false;
    transcriptBySessionId.clear();
    if (!client) {
      for (const sessionId of sessionIds) clearSessionActivity(sessionId);
      return;
    }
    await Promise.allSettled(sessionIds.map(async (sessionId) => {
      try {
        await client!.closeSession(sessionId);
      } finally {
        forgetSessionRuntime(sessionId);
        clearSessionActivity(sessionId);
      }
    }));
    runtimeReadySessionIds.clear();
    runtimeLoadsBySessionId.clear();
    runtimeLoadGenerations.clear();
    configOptionsBySessionId.clear();
  }

  async function closeSessionTab(sessionId: string): Promise<boolean> {
    closeSessionSelector();
    if (sessionMutationRunning) return false;
    if (sessionId === DRAFT_SESSION_TAB_ID) {
      if (!draftSessionTabOpen) return false;
      const wasActive = draftSessionTabActive;
      invalidateDraftSessionMaterialization();
      draftSessionTabOpen = false;
      draftSessionTabActive = false;
      draftSessionTabTouched = false;
      if (!wasActive) return true;
      promptText = "";
      invalidateAttachmentDraft();
      const fallbackSessionId = tabSessions.at(-1)?.sessionId;
      if (fallbackSessionId) await loadSession(fallbackSessionId);
      else {
        cancelSessionHistoryLoad();
        activeSessionId = null;
        activeSessionRuntimeReady = false;
        transcript = emptyTranscript;
        configOptions = [];
      }
      return true;
    }
    if (runningSessionIds.has(sessionId)) {
      const title = sessions.find((session) => session.sessionId === sessionId)?.title || "Untitled conversation";
      if (!window.confirm(`“${title}” is still running.\n\nClosing this tab will stop the active run. Close it?`)) return false;
    }
    sessionPrewarmGeneration += 1;
    if (sessionId !== activeSessionId) {
      operationRunning = true;
      errorMessage = null;
      try {
        await client?.closeSession(sessionId);
        forgetSessionRuntime(sessionId);
        clearSessionActivity(sessionId);
        transcriptBySessionId.delete(sessionId);
        closedSessionTabs = [...closedSessionTabs, sessionId];
        locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((openId) => openId !== sessionId);
      } catch (error) {
        reportError(error);
        return false;
      } finally {
        operationRunning = false;
      }
      return true;
    }

    const nextSessionId = tabSessions.find((session) => session.sessionId !== sessionId)?.sessionId;
    let closed = false;
    operationRunning = true;
    errorMessage = null;
    try {
      await client?.closeSession(sessionId);
      forgetSessionRuntime(sessionId);
      clearSessionActivity(sessionId);
      transcriptBySessionId.delete(sessionId);
      cancelSessionHistoryLoad();
      activeSessionId = null;
      activeSessionRuntimeReady = false;
      transcript = emptyTranscript;
      configOptions = [];
      closedSessionTabs = [...closedSessionTabs, sessionId];
      locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((openId) => openId !== sessionId);
      closed = true;
    } catch (error) {
      reportError(error);
    } finally {
      operationRunning = false;
    }
    if (!closed) return false;
    if (nextSessionId) await loadSession(nextSessionId);
    else await openSessionStartTab();
    return true;
  }

  function showSessionTab(sessionId: string): void {
    closedSessionTabs = closedSessionTabs.filter((closedId) => closedId !== sessionId);
    if (restoredSessionTabs?.includes(sessionId) || locallyOpenedSessionTabs.includes(sessionId)) return;
    locallyOpenedSessionTabs = [...locallyOpenedSessionTabs, sessionId];
  }

  function promoteSessionStart(): void {
    if (draftSessionTabActive) draftSessionTabTouched = true;
  }

  function ensureProvisionalSession(sessionId: string, cwd: string): void {
    if (sessions.some((session) => session.sessionId === sessionId)) return;
    sessions = [{ sessionId, cwd, updatedAt: new Date().toISOString() }, ...sessions];
  }

  function handleSessionTabClick(sessionId: string): void {
    closeProjectSelector();
    closeSessionSelector();
    if (sessionId === DRAFT_SESSION_TAB_ID) {
      if (!draftSessionTabActive) activateDraftSessionTab();
      return;
    }
    if (sessionId !== activeSessionId) void loadSession(sessionId);
  }

  function openSessionSelector(query = "", mode: "open" | "delete" = "open"): void {
    if (!workspace || status !== "ready") return;
    sessionSelectorQuery = query;
    sessionSelectorMode = mode;
    sessionSelectorOpen = true;
    void refreshSessions();
  }

  function closeSessionSelector(_restoreFocus = false): void {
    sessionSelectorOpen = false;
    sessionSelectorQuery = "";
    sessionSelectorMode = "open";
  }

  function selectSession(sessionId: string): void {
    if (draftSessionTabActive) {
      void selectSessionFromDraft(sessionId);
      return;
    }
    if (sessionId === activeSessionId) {
      closeSessionSelector();
      return;
    }
    void replaceCurrentTabWithSession(sessionId);
  }

  async function selectSessionFromDraft(sessionId: string): Promise<void> {
    if (!draftSessionTabActive || sessionMutationRunning) return;
    invalidateDraftSessionMaterialization();
    draftSessionTabOpen = false;
    draftSessionTabActive = false;
    draftSessionTabTouched = false;
    promptText = "";
    invalidateAttachmentDraft();
    await loadSession(sessionId);
  }

  async function deleteSelectedSession(sessionId: string): Promise<void> {
    const requestClient = client;
    if (!requestClient || sessionMutationRunning || runningSessionIds.has(sessionId)) return;
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    const title = session?.title || "Untitled conversation";
    if (!window.confirm(`Permanently delete “${title}”?\n\nThis removes the Pi session file and its DCP sidecar state.`)) return;

    closeSessionSelector();
    const deletingActive = sessionId === activeSessionId;
    const nextSessionId = deletingActive
      ? sessions.find((candidate) => candidate.sessionId !== sessionId)?.sessionId
      : undefined;
    operationRunning = true;
    errorMessage = null;
    try {
      await requestClient.deleteSession(sessionId);
      forgetSessionRuntime(sessionId);
      clearSessionActivity(sessionId);
      transcriptBySessionId.delete(sessionId);
      configOptionsBySessionId.delete(sessionId);
      runtimeReadySessionIds.delete(sessionId);
      runtimeLoadsBySessionId.delete(sessionId);
      sessions = sessions.filter((candidate) => candidate.sessionId !== sessionId);
      restoredSessionTabs = restoredSessionTabs?.filter((id) => id !== sessionId) ?? restoredSessionTabs;
      locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((id) => id !== sessionId);
      closedSessionTabs = [...new Set([...closedSessionTabs, sessionId])];
      if (deletingActive) {
        cancelSessionHistoryLoad();
        activeSessionId = null;
        activeSessionRuntimeReady = false;
        transcript = emptyTranscript;
        configOptions = [];
        forgetActiveSession(workspace);
      }
      await refreshSessions();
    } catch (error) {
      reportError(error);
      return;
    } finally {
      operationRunning = false;
    }

    if (!deletingActive) return;
    if (nextSessionId && sessions.some((candidate) => candidate.sessionId === nextSessionId)) await loadSession(nextSessionId);
    else await openSessionStartTab();
  }

  function activeCustomQuestionId(): string | null {
    const pending = activePendingElicitation;
    if (!pending || pending.kind !== "question") return null;
    const question = pending.questions[pending.state.activeTab];
    if (!question || !pending.state.drafts[question.id]?.customSelected) return null;
    return question.id;
  }

  function canAcceptDroppedAttachments(): boolean {
    const pending = activePendingElicitation;
    if (
      pending?.kind === "question"
      && questionImageOperationIds.has(pending.requestId)
    ) return false;
    if (pending?.kind === "question") return activeCustomQuestionId() !== null;
    return (!!activeSessionId || draftSessionTabActive) && !sessionMutationRunning;
  }

  function questionCanAcceptImages(questionId: string, requestId?: number): boolean {
    const pending = requestId === undefined
      ? (activePendingElicitation?.kind === "question" ? activePendingElicitation : null)
      : pendingQuestionForRequestId(requestId);
    return !!pending
      && pending.questions.some((question) => question.id === questionId)
      && pending.state.drafts[questionId]?.customSelected === true;
  }

  function questionRequestIsActive(requestId: number): boolean {
    return activePendingElicitation?.kind === "question" && activePendingElicitation.requestId === requestId;
  }

  function questionImageRequestId(questionId: string): number | null {
    const pending = activePendingElicitation;
    return pending?.kind === "question" && questionCanAcceptImages(questionId)
      ? pending.requestId
      : null;
  }

  function beginQuestionImageOperation(requestId: number): number | null {
    if (questionImageOperationIds.has(requestId)) return null;
    const operationId = ++questionImageOperationSequence;
    const next = new Map(questionImageOperationIds);
    next.set(requestId, operationId);
    questionImageOperationIds = next;
    return operationId;
  }

  function finishQuestionImageOperation(requestId: number, operationId: number): void {
    if (questionImageOperationIds.get(requestId) !== operationId) return;
    const next = new Map(questionImageOperationIds);
    next.delete(requestId);
    questionImageOperationIds = next;
  }

  function cancelQuestionImageOperation(requestId?: number): void {
    if (requestId === undefined) {
      questionImageOperationIds = new Map();
      return;
    }
    if (!questionImageOperationIds.has(requestId)) return;
    const next = new Map(questionImageOperationIds);
    next.delete(requestId);
    questionImageOperationIds = next;
  }

  async function chooseQuestionImages(questionId: string, expectedRequestId?: number): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId)) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach images to answer",
        ...(workspace ? { defaultPath: workspace } : {}),
      });
      if (!selected) return;
      await appendQuestionImagePaths(questionId, requestId, typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function addQuestionImagePaths(questionId: string, paths: readonly string[]): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || paths.length === 0) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      await appendQuestionImagePaths(questionId, requestId, paths);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function appendQuestionImagePaths(
    questionId: string,
    requestId: number,
    paths: readonly string[],
  ): Promise<void> {
    const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths });
    const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
      name: file.name,
      size: file.size,
      mimeType: mimeTypeForName(file.name),
      readData: () => invoke<string>("read_attachment_base64", { path: file.path }),
    })));
    if (issue && questionRequestIsActive(requestId)) errorMessage = issue;
  }

  async function addPastedQuestionImages(
    questionId: string,
    files: readonly File[],
    expectedRequestId?: number,
  ): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId) || files.length === 0) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
        name: file.name,
        size: file.size,
        mimeType: file.type || mimeTypeForName(file.name),
        readData: () => fileBase64(file),
      })));
      if (issue && questionRequestIsActive(requestId)) errorMessage = issue;
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function appendQuestionImageCandidates(
    questionId: string,
    requestId: number,
    candidates: readonly QuestionImageCandidate[],
  ): Promise<string | null> {
    const images: QuestionImage[] = [];
    let issue: string | null = null;
    let queuedBytes = 0;
    for (const candidate of candidates) {
      let pending = pendingQuestionForRequestId(requestId);
      if (!pending || !questionCanAcceptImages(questionId, requestId)) return null;
      if (totalQuestionImageCount(pending.state) + images.length >= MAX_QUESTION_IMAGES) {
        issue = `Attach at most ${MAX_QUESTION_IMAGES} images to a questionnaire.`;
        break;
      }
      if (attachmentKind(candidate.mimeType) !== "image") {
        issue = "Only image files can be attached to an answer.";
        continue;
      }
      if (candidate.size <= 0) {
        issue = `${candidate.name} is empty and could not be attached.`;
        continue;
      }
      if (candidate.size > MAX_QUESTION_IMAGE_BYTES) {
        issue = `${candidate.name} is too large (maximum 25 MB).`;
        continue;
      }
      const data = await candidate.readData();
      pending = pendingQuestionForRequestId(requestId);
      if (!pending || !questionCanAcceptImages(questionId, requestId)) return null;
      const decodedBytes = decodedQuestionImageBytes(data);
      if (decodedBytes === null || decodedBytes === 0) {
        issue = `${candidate.name} is empty or invalid and could not be attached.`;
        continue;
      }
      if (decodedBytes > MAX_QUESTION_IMAGE_BYTES) {
        issue = `${candidate.name} is too large (maximum 25 MB).`;
        continue;
      }
      if (totalQuestionImageBytes(pending.state) + queuedBytes + decodedBytes > MAX_QUESTION_IMAGE_BYTES_TOTAL) {
        issue = "Question images can total at most 50 MB.";
        break;
      }
      images.push({
        type: "image",
        data,
        mimeType: candidate.mimeType,
        name: candidate.name,
        size: decodedBytes,
      });
      queuedBytes += decodedBytes;
    }
    appendQuestionImages(questionId, requestId, images);
    return issue;
  }

  function appendQuestionImages(questionId: string, requestId: number, images: readonly QuestionImage[]): void {
    const pending = pendingQuestionForRequestId(requestId);
    if (
      !pending
      || !questionCanAcceptImages(questionId, requestId)
      || images.length === 0
    ) return;
    const question = pending.questions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    replacePendingElicitation({
      ...pending,
      state: addQuestionImages(pending.state, questionId, images, question),
    });
  }

  function openQuestionImage(image: QuestionImage): void {
    void activateAttachment({
      id: nextAttachmentId(),
      name: image.name,
      kind: "image",
      mimeType: image.mimeType,
      size: image.size,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
    });
  }

  async function chooseTaskAttachments(current: readonly Attachment[]): Promise<Attachment[]> {
    if (!workspace || operationRunning) return [...current];
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach files to task",
        defaultPath: workspace,
      });
      if (!selected) return [...current];
      return await addTaskAttachmentPaths(current, typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      reportError(error);
      return [...current];
    }
  }

  async function addTaskAttachmentPaths(
    current: readonly Attachment[],
    paths: readonly string[],
  ): Promise<Attachment[]> {
    const existingPaths = new Set(current.flatMap((attachment) => attachment.path ? [attachment.path] : []));
    const available = MAX_ATTACHMENTS - current.length;
    if (available <= 0) {
      if (paths.length > 0) errorMessage = `Attach at most ${MAX_ATTACHMENTS} files.`;
      return [...current];
    }
    const candidates = paths.filter((path) => !existingPaths.has(path)).slice(0, available);
    if (candidates.length === 0) return [...current];
    try {
      const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths: candidates });
      const additions = files.map((file) => attachmentFromFile(file, nextAttachmentId()));
      if (candidates.length < paths.length) errorMessage = `Only the first ${MAX_ATTACHMENTS} files were attached.`;
      return [...current, ...additions];
    } catch (error) {
      reportError(error);
      return [...current];
    }
  }

  async function pasteTaskAttachments(
    files: readonly File[],
    current: readonly Attachment[],
  ): Promise<Attachment[]> {
    if (!workspace || operationRunning || files.length === 0) return [...current];
    const requestWorkspace = workspace;
    const available = MAX_ATTACHMENTS - current.length;
    if (available <= 0) {
      errorMessage = `Attach at most ${MAX_ATTACHMENTS} files.`;
      return [...current];
    }
    try {
      const additions: Attachment[] = [];
      for (const file of files.slice(0, available)) {
        if (file.size > MAX_EMBEDDED_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is too large to paste (maximum 25 MB).`);
        }
        const cached = await cachePastedTaskAttachment(file, requestWorkspace);
        if (workspace !== requestWorkspace) return [...current];
        const inferredMimeType = mimeTypeForName(file.name);
        const mimeType = file.type || inferredMimeType;
        const base = attachmentFromFile(cached, nextAttachmentId());
        additions.push({ ...base, kind: attachmentKind(mimeType), mimeType });
      }
      if (files.length > available) errorMessage = `Only the first ${MAX_ATTACHMENTS} files were attached.`;
      return [...current, ...additions];
    } catch (error) {
      reportError(error);
      return [...current];
    }
  }

  async function chooseAttachments(): Promise<void> {
    if ((!activeSessionId && !draftSessionTabActive) || sessionMutationRunning) return;
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach files",
        ...(workspace ? { defaultPath: workspace } : {}),
      });
      if (!selected) return;
      await addAttachmentPaths(typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      reportError(error);
    }
  }

  function enqueueAttachmentDraftOperation(key: string, run: () => Promise<void>): Promise<void> {
    const previous = attachmentAddQueues.get(key) ?? Promise.resolve();
    const operation = previous.then(run);
    const tracked = operation.catch(() => undefined);
    attachmentAddQueues.set(key, tracked);
    void tracked.finally(() => {
      if (attachmentAddQueues.get(key) === tracked) attachmentAddQueues.delete(key);
    });
    return operation;
  }

  function addAttachmentPaths(paths: readonly string[]): Promise<void> {
    const key = attachmentDraftKey;
    const generation = attachmentDraftGeneration;
    return enqueueAttachmentDraftOperation(key, () => addAttachmentPathsNow(paths, key, generation));
  }

  async function addAttachmentPathsNow(
    paths: readonly string[],
    key: string,
    generation: number,
  ): Promise<void> {
    if (!attachmentDraftIsCurrent(key, generation)) return;
    const existingPaths = new Set(promptAttachments.flatMap((attachment) => attachment.path ? [attachment.path] : []));
    const available = MAX_ATTACHMENTS - promptAttachments.length;
    const candidates = paths.filter((path) => !existingPaths.has(path)).slice(0, Math.max(0, available));
    if (candidates.length === 0) {
      if (paths.length > 0 && available <= 0) errorMessage = `Attach at most ${MAX_ATTACHMENTS} files.`;
      return;
    }
    try {
      const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths: candidates });
      if (!attachmentDraftIsCurrent(key, generation)) return;
      const attachments = files.map((file) => attachmentFromFile(file, nextAttachmentId()));
      promptAttachments = [...promptAttachments, ...attachments];
      if (candidates.length < paths.length) errorMessage = `Only the first ${MAX_ATTACHMENTS} files were attached.`;
    } catch (error) {
      reportError(error);
    }
  }

  function addPastedAttachments(files: readonly File[]): Promise<void> {
    const key = attachmentDraftKey;
    const generation = attachmentDraftGeneration;
    return enqueueAttachmentDraftOperation(key, () => addPastedAttachmentsNow(files, key, generation));
  }

  async function addPastedAttachmentsNow(
    files: readonly File[],
    key: string,
    generation: number,
  ): Promise<void> {
    if (!attachmentDraftIsCurrent(key, generation)) return;
    if ((!activeSessionId && !draftSessionTabActive) || sessionMutationRunning || files.length === 0) return;
    const available = MAX_ATTACHMENTS - promptAttachments.length;
    if (available <= 0) {
      errorMessage = `Attach at most ${MAX_ATTACHMENTS} files.`;
      return;
    }
    try {
      const attachments: Attachment[] = [];
      for (const file of files.slice(0, available)) {
        if (!attachmentDraftIsCurrent(key, generation)) return;
        if (file.size > MAX_EMBEDDED_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is too large to paste (maximum 25 MB).`);
        }
        const cached = await cachePastedAttachment(file);
        if (!attachmentDraftIsCurrent(key, generation)) return;
        const inferredMimeType = mimeTypeForName(file.name);
        const mimeType = file.type || inferredMimeType;
        const kind = attachmentKind(mimeType);
        const base = attachmentFromFile(cached, nextAttachmentId());
        attachments.push({
          ...base,
          kind,
          mimeType,
        });
      }
      promptAttachments = [...promptAttachments, ...attachments];
      if (files.length > available) errorMessage = `Only the first ${MAX_ATTACHMENTS} files were attached.`;
    } catch (error) {
      reportError(error);
    }
  }

  function attachmentDraftIsCurrent(key: string, generation: number): boolean {
    return key === attachmentDraftKey
      && generation === attachmentDraftGeneration
      && (!!activeSessionId || draftSessionTabActive)
      && !sessionMutationRunning;
  }

  function invalidateAttachmentDraft(): void {
    // Pending file inspection/cache work may still finish, but the generation
    // guard below makes those completions inert. Detach their queues as well so
    // a new draft (notably the reused synthetic draft-tab key) never waits on
    // stale I/O from a draft that was already abandoned.
    attachmentAddQueues.clear();
    attachmentDraftGeneration += 1;
    promptAttachments = [];
  }

  function removeAttachment(id: string): void {
    promptAttachments = promptAttachments.filter((attachment) => attachment.id !== id);
  }

  function nextAttachmentId(): string {
    attachmentSequence += 1;
    return `local-attachment:${attachmentSequence}`;
  }

  function workspaceEditorLabel(value: string): string {
    const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
    return normalized.split("/").at(-1) || value;
  }

  function selectWorkspaceEditor(id: WorkspaceEditorId): void {
    if (!workspaceEditorTabs.some((tab) => tab.id === id)) return;
    activeWorkspaceEditor = id;
  }

  function closeWorkspaceEditor(id: WorkspaceEditorId): void {
    if (id === "preview") {
      if (previewPane) previewPane.requestClose();
      else closePreview();
      return;
    }
    if (id === "git-diff") closeGitDiff();
  }

  function closeGitDiff(): void {
    const fallback = workspaceEditorCloseFallback(workspaceEditorTabs, "git-diff");
    gitDiffPreview = null;
    gitDiffReview = undefined;
    if (activeWorkspaceEditor === "git-diff") activeWorkspaceEditor = fallback;
  }

  function showPreview(target: PreviewTarget, navigation: PreviewNavigation): void {
    previewSequence += 1;
    const entry: PreviewEntry = {
      ...target,
      id: previewSequence,
      scrollPosition: { left: 0, top: 0 },
    };
    previewHistory = navigation === "push"
      ? pushPreviewHistory(previewHistory, entry)
      : resetPreviewHistory(entry);
    previewDirty = false;
    activeWorkspaceEditor = "preview";
  }

  function rememberPreviewScroll(id: number, scrollPosition: PreviewScrollPosition): void {
    const entry = currentPreview(previewHistory);
    if (!entry || entry.id !== id) return;
    if (
      entry.scrollPosition.left === scrollPosition.left
      && entry.scrollPosition.top === scrollPosition.top
    ) return;
    previewHistory = replaceCurrentPreview(previewHistory, { ...entry, scrollPosition });
  }

  function closePreview(): void {
    const fallback = workspaceEditorCloseFallback(workspaceEditorTabs, "preview");
    projectFilePreviewGeneration += 1;
    previewHistory = emptyPreviewHistory();
    previewDirty = false;
    if (activeWorkspaceEditor === "preview") activeWorkspaceEditor = fallback;
  }

  function movePreview(offset: -1 | 1): void {
    projectFilePreviewGeneration += 1;
    previewHistory = movePreviewHistory(previewHistory, offset);
  }

  async function activateAttachment(attachment: Attachment): Promise<void> {
    if ((attachment.deferredImageId && !attachment.dataUrl)
      || (attachment.path && !registeredAttachmentPaths.has(attachment.path))) {
      try {
        await prepareTranscriptAttachment(attachment);
      } catch (error) {
        reportError(error);
        return;
      }
    }
    const preparedAttachment = transcript.items
      .flatMap((item) => item.attachments)
      .find((candidate) => candidate.id === attachment.id) ?? attachment;
    if (preparedAttachment.kind === "image" || preparedAttachment.kind === "video") {
      showPreview({ kind: "attachment", attachment: preparedAttachment }, "replace");
      return;
    }
    if (!preparedAttachment.path) {
      errorMessage = `Cannot open ${preparedAttachment.name}: no local path is available.`;
      return;
    }
    try {
      await invoke("open_attachment", { path: preparedAttachment.path });
    } catch (error) {
      reportError(error);
    }
  }

  const fileValidationRequests = new Map<string, Promise<boolean>>();

  function sharedFileValidation(
    key: string,
    request: () => Promise<boolean>,
  ): Promise<boolean> {
    const existing = fileValidationRequests.get(key);
    if (existing) return existing;
    const promise = request()
      .catch(() => false)
      .finally(() => {
        if (fileValidationRequests.get(key) === promise) fileValidationRequests.delete(key);
      });
    fileValidationRequests.set(key, promise);
    return promise;
  }

  async function validateProjectFile(path: string): Promise<boolean> {
    const requestWorkspace = workspace;
    if (!requestWorkspace) return false;
    const exists = await sharedFileValidation(
      `project\0${requestWorkspace}\0${path}`,
      () => invoke<boolean>("project_file_exists", { workspace: requestWorkspace, path }),
    );
    return workspace === requestWorkspace && exists;
  }

  async function validateLocalFile(path: string): Promise<boolean> {
    const command = path.startsWith("~/") ? "home_file_exists" : "local_file_exists";
    return sharedFileValidation(`${command}\0${path}`, () => invoke<boolean>(command, { path }));
  }

  async function openProjectFile(
    path: string,
    navigation: PreviewNavigation = "replace",
    lineRange?: ProjectFileLineRange,
  ): Promise<void> {
    if (!workspace) {
      errorMessage = "Open a workspace before previewing project files.";
      return;
    }

    const requestWorkspace = workspace;
    const generation = ++projectFilePreviewGeneration;
    const mediaKind = attachmentKind(mimeTypeForName(path));
    try {
      if (mediaKind !== "file") {
        const attachment = await resolveProjectMedia(path);
        if (!attachment || generation !== projectFilePreviewGeneration || workspace !== requestWorkspace) return;
        showPreview({ kind: "attachment", attachment }, navigation);
        return;
      }
      const preview = await invoke<ProjectFilePreview>("read_project_file", {
        workspace: requestWorkspace,
        path,
      });
      if (generation !== projectFilePreviewGeneration || workspace !== requestWorkspace) return;
      showPreview({ kind: "file", file: preview, ...(lineRange ? { lineRange } : {}) }, navigation);
    } catch (error) {
      if (generation === projectFilePreviewGeneration) reportError(error);
    }
  }

  async function resolveProjectMedia(path: string): Promise<Attachment | undefined> {
    const requestWorkspace = workspace;
    if (!requestWorkspace || attachmentKind(mimeTypeForName(path)) === "file") return undefined;

    const file = await invoke<AttachmentFile>("resolve_project_media", {
      workspace: requestWorkspace,
      path,
    });
    if (workspace !== requestWorkspace) return undefined;
    return attachmentFromFile(file, `project-media:${requestWorkspace}:${path}`);
  }

  async function openLocalFile(path: string, navigation: PreviewNavigation = "replace"): Promise<void> {
    const generation = ++projectFilePreviewGeneration;
    const isHomePath = path.startsWith("~/");
    if (attachmentKind(mimeTypeForName(path)) !== "file") {
      try {
        const attachment = isHomePath
          ? await resolveHomeMedia(path)
          : await resolveLocalMedia(path);
        if (!attachment || generation !== projectFilePreviewGeneration) return;
        showPreview({ kind: "attachment", attachment }, navigation);
      } catch (error) {
        if (generation === projectFilePreviewGeneration) reportError(error);
      }
      return;
    }

    if (isHomePath) {
      try {
        const preview = await invoke<ProjectFilePreview>("read_home_file", { path });
        if (generation !== projectFilePreviewGeneration) return;
        showPreview({ kind: "file", file: preview }, navigation);
      } catch (error) {
        if (generation === projectFilePreviewGeneration) reportError(error);
      }
      return;
    }

    try {
      await invoke("open_local_file", { path });
    } catch (error) {
      reportError(error);
    }
  }

  async function resolveHomeMedia(path: string): Promise<Attachment | undefined> {
    if (attachmentKind(mimeTypeForName(path)) === "file") return undefined;
    const file = await invoke<AttachmentFile>("resolve_home_media", { path });
    return attachmentFromFile(file, `home-media:${path}`);
  }

  async function resolveLocalMedia(path: string): Promise<Attachment | undefined> {
    if (attachmentKind(mimeTypeForName(path)) === "file") return undefined;
    const file = await invoke<AttachmentFile>("resolve_local_media", { path });
    return attachmentFromFile(file, `local-media:${path}`);
  }

  async function buildPromptPayload(
    text: string,
    attachments: readonly Attachment[],
  ): Promise<{ blocks: ContentBlock[]; fileImages: PromptFileImage[] }> {
    const blocks: ContentBlock[] = [];
    const fileImages: PromptFileImage[] = [];
    let embeddedBytes = 0;
    if (text) blocks.push({ type: "text", text });
    for (const attachment of attachments) {
      if (attachment.kind === "image" && imagePromptSupported) {
        if (attachment.path) {
          if ((attachment.size ?? 0) > MAX_EMBEDDED_ATTACHMENT_BYTES) {
            throw new Error(`${attachment.name} is too large to send as an image (maximum 25 MB).`);
          }
          embeddedBytes += attachment.size ?? 0;
          if (embeddedBytes > MAX_EMBEDDED_PROMPT_BYTES) {
            throw new Error("Attached images exceed the 50 MB combined prompt limit.");
          }
          const uri = fileUriFromPath(attachment.path);
          blocks.push({
            type: "resource_link",
            uri,
            name: attachment.name,
            mimeType: attachment.mimeType,
            ...(attachment.size ? { size: attachment.size } : {}),
          });
          fileImages.push({
            uri,
            mimeType: attachment.mimeType,
            ...(attachment.size === undefined ? {} : { size: attachment.size }),
            name: attachment.name,
          });
          continue;
        }

        const dataUrl = attachment.dataUrl;
        if (!dataUrl) throw new Error(`Cannot read ${attachment.name}.`);
        const separator = dataUrl.indexOf(",");
        if (separator < 0) throw new Error(`Cannot decode ${attachment.name}.`);
        const data = dataUrl.slice(separator + 1);
        embeddedBytes += Math.floor(data.length * 3 / 4);
        if (embeddedBytes > MAX_EMBEDDED_PROMPT_BYTES) {
          throw new Error("Attached images exceed the 50 MB combined prompt limit.");
        }
        blocks.push({
          type: "image",
          data,
          mimeType: attachment.mimeType,
        });
        continue;
      }
      if (!attachment.path) {
        throw new Error(`${attachment.name} cannot be sent because it has no local path.`);
      }
      blocks.push({
        type: "resource_link",
        uri: fileUriFromPath(attachment.path),
        name: attachment.name,
        mimeType: attachment.mimeType,
        ...(attachment.size ? { size: attachment.size } : {}),
      });
    }
    return { blocks, fileImages };
  }

  async function fileBase64(file: File): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        const separator = value.indexOf(",");
        if (separator < 0) {
          reject(new Error(`Failed to encode ${file.name}.`));
          return;
        }
        resolve(value.slice(separator + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async function cachePastedAttachment(file: File): Promise<AttachmentFile> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke<AttachmentFile>("cache_attachment", bytes, {
      headers: { "x-pix-attachment-name": utf8Base64(file.name) },
    });
  }

  async function cachePastedTaskAttachment(
    file: File,
    requestWorkspace: string,
  ): Promise<AttachmentFile> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return cacheTaskAttachmentBytes(file.name, bytes, requestWorkspace);
  }

  async function cacheTaskAttachmentBytes(
    name: string,
    bytes: Uint8Array,
    requestWorkspace: string,
  ): Promise<AttachmentFile> {
    return invoke<AttachmentFile>("cache_task_attachment", bytes, {
      headers: {
        "x-pix-attachment-name": utf8Base64(name),
        "x-pix-workspace": utf8Base64(requestWorkspace),
      },
    });
  }

  async function materializeComposerTaskAttachments(
    attachments: readonly Attachment[],
    requestWorkspace: string,
    requestClient: AcpClient | null,
    requestSessionId: string | null,
  ): Promise<Attachment[]> {
    const stored: Attachment[] = [];
    for (const attachment of attachments) {
      if (attachment.path) {
        stored.push(attachment);
        continue;
      }

      let dataUrl = attachment.dataUrl;
      if (!dataUrl && attachment.deferredImageId && requestClient && requestSessionId) {
        const image = await requestClient.sessionImage(requestSessionId, attachment.deferredImageId);
        dataUrl = `data:${image.mimeType};base64,${image.data}`;
      }
      const bytes = dataUrl ? attachmentDataUrlBytes(dataUrl) : undefined;
      if (!bytes) throw new Error(`Cannot persist attachment ${attachment.name} in a project task.`);
      const cached = await cacheTaskAttachmentBytes(attachment.name, bytes, requestWorkspace);
      stored.push({ ...attachment, path: cached.path, size: cached.size });
    }
    return stored;
  }

  function utf8Base64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function decodedQuestionImageBytes(value: string): number | null {
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding;
  }

  async function waitForAttachmentDraftSettled(key: string): Promise<void> {
    let pending = attachmentAddQueues.get(key);
    while (true) {
      if (!pending) return;
      await pending.catch(() => undefined);
      const next = attachmentAddQueues.get(key);
      if (!next || next === pending) return;
      pending = next;
    }
  }

  async function submitPrompt(): Promise<void> {
    if (!client || sessionMutationRunning || sessionHistoryLoading) return;
    // File inspection/caching is asynchronous. Wait for every attachment add
    // already initiated by the user before snapshotting the draft, otherwise a
    // fast Enter can send the text first and silently drop the pending file.
    const initialDraftKey = attachmentDraftKey;
    await waitForAttachmentDraftSettled(initialDraftKey);
    if (initialDraftKey !== attachmentDraftKey) return;
    const text = promptText.trim();
    const attachments = promptAttachments;
    let sessionId = activeSessionId;
    let draftKey = attachmentDraftKey;
    let draftGeneration = attachmentDraftGeneration;
    if (
      !client
      || (!text && attachments.length === 0)
      || sessionMutationRunning
      || sessionHistoryLoading
    ) return;
    const desktopCommand = parseDesktopSlashCommand(text, attachments.length > 0);
    if (desktopCommand) {
      switch (desktopCommand.kind) {
        case "new":
        case "new_tab":
          if (promptRunning) return;
          promptText = "";
          await openSessionStartTab();
          break;
        case "enhance":
          if (promptRunning) return;
          promptText = "";
          await enhancePromptDraft(desktopCommand.draft);
          break;
        case "import":
          if (promptRunning) return;
          promptText = "";
          if (desktopCommand.path) await importConversationPath(desktopCommand.path);
          else await chooseImportSession();
          break;
        case "queue": {
          let message = desktopCommand.message;
          if (!message && attachments.length === 0) {
            message = await requestLocalTextInput("Enter the message to pause and send later.", "Queued message") ?? "";
          }
          if (!message && attachments.length === 0) return;
          await deferDraft(message, attachments, { clearComposer: true });
          break;
        }
        case "resume":
          if (promptRunning) return;
          promptText = "";
          if (desktopCommand.path) await resumeConversationPath(desktopCommand.path);
          else openSessionSelector();
          break;
        case "search":
          promptText = "";
          openSessionSelector(desktopCommand.query, "open");
          break;
        case "delete":
          if (promptRunning) return;
          promptText = "";
          openSessionSelector(desktopCommand.query, "delete");
          break;
        case "jump":
          promptText = "";
          await openJumpPicker(desktopCommand.query);
          break;
        case "history":
          promptText = "";
          await openHistoryPicker(desktopCommand.query);
          break;
        case "hotkeys":
          promptText = "";
          showDesktopHotkeys();
          break;
        case "quit":
          promptText = "";
          await getCurrentWindow().close();
          break;
        case "reload":
          if (promptRunning) return;
          promptText = "";
          await reloadResources();
          break;
        case "fork":
          if (promptRunning) return;
          promptText = "";
          await forkConversation(desktopCommand.entryId);
          break;
        case "model":
          if (promptRunning) return;
          promptText = "";
          closeProjectSelector();
          closeSessionSelector();
          if (desktopCommand.value) await applyModelSlashCommand(desktopCommand.value);
          else commandPicker = commandPickerState("model", configOptions);
          break;
        case "thinking":
          if (promptRunning) return;
          promptText = "";
          closeProjectSelector();
          closeSessionSelector();
          if (desktopCommand.level) await applyThinkingSlashCommand(desktopCommand.level);
          else commandPicker = commandPickerState("thinking", configOptions);
          break;
      }
      return;
    }

    if (!sessionId) {
      if (!draftSessionTabActive) return;
      sessionId = await materializeDraftSession();
      if (!sessionId) return;
      draftKey = attachmentDraftKey;
      draftGeneration = attachmentDraftGeneration;
    }
    if (!activeSessionRuntimeReady) return;

    if (promptRunning) {
      if (text.startsWith("/")) {
        reportError(new Error("Slash commands cannot run while the agent is responding. Use /queue to pause a message for later."));
        return;
      }
      await queueDraftForCurrentRun(text, attachments, draftKey, draftGeneration);
      return;
    }

    let reloadAfterSlash = false;
    errorMessage = null;
    try {
      const { blocks, fileImages } = await buildPromptPayload(text, attachments);
      if (
        sessionId !== activeSessionId
        || draftKey !== attachmentDraftKey
        || draftGeneration !== attachmentDraftGeneration
        || attachments !== promptAttachments
      ) return;
      promptText = "";
      invalidateAttachmentDraft();
      const transcriptMessageId = `local:${++localMessageId}`;
      transcript = appendLocalUserMessage(transcript, text, transcriptMessageId, attachments);
      transcriptBySessionId.set(sessionId, transcript);
      await scrollToLatest();
      await runPromptRequest(client, sessionId, blocks, fileImages, transcriptMessageId);
      if (text.startsWith("/")) await refreshAutocompleteSettings(sessionId);
      reloadAfterSlash = /^\/(?:scoped-models|no-context-files)(?:\s|$)/i.test(text);
      void refreshSessions();
    } catch (error) {
      reportError(error);
    }
    if (reloadAfterSlash && sessionId === activeSessionId) await reloadResources({ echo: false });
  }

  async function queueDraftForCurrentRun(
    text: string,
    attachments: readonly Attachment[],
    draftKey: string,
    draftGeneration: number,
  ): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId) return;
    try {
      const { blocks, fileImages } = await buildPromptPayload(text, attachments);
      if (
        requestClient !== client
        || sessionId !== activeSessionId
        || draftKey !== attachmentDraftKey
        || draftGeneration !== attachmentDraftGeneration
        || attachments !== promptAttachments
      ) return;
      promptText = "";
      invalidateAttachmentDraft();
      await requestClient.queueMessage(sessionId, blocks, text, fileImages);
      void refreshQueueState(sessionId);
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) {
        if (!promptText && promptAttachments.length === 0) {
          attachmentDraftGeneration += 1;
          promptText = text;
          promptAttachments = [...attachments];
        }
        reportError(error);
      }
    }
  }

  async function deferCurrentDraft(): Promise<void> {
    await deferDraft(promptText.trim(), promptAttachments, { clearComposer: true });
  }

  async function deferDraft(
    text: string,
    attachments: readonly Attachment[],
    options: { clearComposer: boolean },
  ): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || (!text && attachments.length === 0)) return;
    const draftKey = attachmentDraftKey;
    const draftGeneration = attachmentDraftGeneration;
    try {
      const { blocks, fileImages } = await buildPromptPayload(text, attachments);
      if (
        requestClient !== client
        || sessionId !== activeSessionId
        || draftKey !== attachmentDraftKey
        || draftGeneration !== attachmentDraftGeneration
        || attachments !== promptAttachments
      ) return;
      await requestClient.deferMessage(sessionId, blocks, text, fileImages);
      if (options.clearComposer) {
        promptText = "";
        invalidateAttachmentDraft();
      }
      void refreshQueueState(sessionId);
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    }
  }

  async function actOnQueuedMessage(item: QueueItem, action: QueueAction): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || queueActionRunning) return;
    queueActionRunning = true;
    errorMessage = null;
    try {
      const result = await requestClient.queueAction(sessionId, item, action);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      if (action === "edit") {
        if (!result.message) throw new Error("Queued message is no longer available.");
        restoreQueuedMessageToComposer(result.message);
        await promptComposer?.focus();
        return;
      }
      if (action !== "send-now") return;
      if (!result.message) throw new Error("Queued message is no longer available.");

      // Send-now can abort a currently running prompt inside ACP. Wait for the
      // old Desktop request promise to observe that settlement before opening
      // the next run, avoiding a client-side overlap race.
      await promptRunsBySessionId.get(sessionId)?.catch(() => undefined);
      const transcriptMessageId = appendQueuedMessageToTranscript(sessionId, result.message);
      await runPromptRequest(requestClient, sessionId, queuedMessageBlocks(result.message), [], transcriptMessageId);
      void refreshSessions();
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      queueActionRunning = false;
    }
  }

  function desktopCommandEnabled(id: DesktopCommandId): boolean {
    switch (id) {
      case "application.commandPalette":
        return activePendingElicitation?.kind !== "form";
      case "workspace.choose":
        return !anyPromptRunning && !sessionMutationRunning && !tasksSaving && taskActionId === null;
      case "editor.conversation":
        return workspaceEditorTabs.length > 1 && activeWorkspaceEditor !== "conversation";
      case "editor.preview":
        return !!activePreview && activeWorkspaceEditor !== "preview";
      case "editor.gitDiff":
        return !!gitDiffPreview && activeWorkspaceEditor !== "git-diff";
      case "editor.close":
        return activeWorkspaceEditor !== "conversation";
      case "session.new":
        return canUseSession;
      case "session.open":
        return status === "ready" && !!workspace && !sessionMutationRunning;
      case "session.jump":
      case "session.history":
        return !!client && !!activeSessionId && activeSessionRuntimeReady && !sessionMutationRunning;
      case "session.activity":
        return !!activeSessionId;
      case "session.modelThinking":
        return !!activeSessionId
          && activeSessionRuntimeReady
          && !sessionMutationRunning
          && !promptRunning
          && changingConfig === null;
      case "composer.focus":
        return draftSessionTabActive || !!activeSessionId;
      case "composer.enhance":
      case "composer.createTask":
      case "composer.defer":
      case "message.copy":
      case "message.fork":
      case "message.forkNewTab":
      case "message.undo":
        return false;
    }
  }

  async function openDesktopCommandPalette(): Promise<void> {
    if (!desktopCommandEnabled("application.commandPalette")) return;
    closeProjectSelector();
    closeSessionSelector();
    closeModelThinkingPicker();
    if (commandPicker && commandPicker.command !== "commands") {
      commandPicker = null;
      await tick();
    }
    const commands = COMMAND_PALETTE_IDS
      .filter((id) => desktopCommandEnabled(id))
      .map((id) => desktopCommandDefinition(id));
    commandPicker = desktopCommandPickerState(commands, desktopShortcutPlatform);
  }

  async function executeDesktopCommand(id: DesktopCommandId): Promise<void> {
    if (!desktopCommandEnabled(id)) return;
    switch (id) {
      case "application.commandPalette":
        await openDesktopCommandPalette();
        return;
      case "workspace.choose":
        await chooseWorkspace();
        return;
      case "editor.conversation":
        selectWorkspaceEditor("conversation");
        return;
      case "editor.preview":
        selectWorkspaceEditor("preview");
        return;
      case "editor.gitDiff":
        selectWorkspaceEditor("git-diff");
        return;
      case "editor.close":
        closeWorkspaceEditor(activeWorkspaceEditor);
        return;
      case "session.new":
        await openSessionStartTab();
        return;
      case "session.open":
        await openSessionStartTab();
        return;
      case "session.jump":
        await openJumpPicker("");
        return;
      case "session.history":
        await openHistoryPicker("");
        return;
      case "session.activity":
        setSessionInspectorOpen(!sessionInspectorOpen);
        return;
      case "session.modelThinking":
        await openModelThinkingPicker();
        return;
      case "composer.focus":
        await promptComposer?.focus();
        return;
      case "composer.enhance":
      case "composer.createTask":
      case "composer.defer":
      case "message.copy":
      case "message.fork":
      case "message.forkNewTab":
      case "message.undo":
        return;
    }
  }

  function handleApplicationKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const paletteCommand = desktopCommandDefinition("application.commandPalette");
    if (matchesDesktopShortcut(event, paletteCommand.shortcut, desktopShortcutPlatform)) {
      event.preventDefault();
      if (commandPicker?.command === "commands") {
        commandPicker = null;
        return;
      }
      void openDesktopCommandPalette();
      return;
    }

    const newSessionCommand = desktopCommandDefinition("session.new");
    if (!matchesDesktopShortcut(event, newSessionCommand.shortcut, desktopShortcutPlatform)) return;
    if (!desktopCommandEnabled("session.new") || commandPicker || modelThinkingPickerOpen || sessionSelectorOpen) return;
    event.preventDefault();
    void executeDesktopCommand("session.new");
  }

  async function selectCommandOption(value: string): Promise<void> {
    const picker = commandPicker;
    if (!picker) return;
    commandPicker = null;
    if (picker.command === "commands") {
      if (!isDesktopCommandId(value)) return;
      await tick();
      await executeDesktopCommand(value);
      return;
    }
    if (picker.command === "history") {
      promptText = value;
      return;
    }
    if (picker.command === "jump") {
      await jumpToUserMessage(value);
      return;
    }
    if (picker.command === "model") {
      await applyModelSlashCommand(value);
      return;
    }
    if (picker.command === "thinking") {
      await applyThinkingSlashCommand(value);
    }
  }

  async function openModelThinkingPicker(): Promise<void> {
    if (!activeSessionId || !activeSessionRuntimeReady || operationRunning || promptRunning || changingConfig) return;
    const sessionId = activeSessionId;
    commandPicker = null;
    await visibleModelsSavePromise?.catch(() => undefined);
    if (sessionId !== activeSessionId || !activeSessionRuntimeReady || operationRunning || promptRunning || changingConfig) return;
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "pix" });
      visibleModelRefs = visibleModelRefsFromPixConfig(document.content);
    } catch {
      // A missing/unreadable preference falls back to the full model catalog.
      visibleModelRefs = undefined;
    }
    if (sessionId !== activeSessionId || !activeSessionRuntimeReady || operationRunning || promptRunning || changingConfig) return;
    modelThinkingPickerSessionId = sessionId;
    modelThinkingPickerOpen = true;
  }

  function closeModelThinkingPicker(): void {
    modelThinkingPickerOpen = false;
    modelThinkingPickerSessionId = null;
  }

  async function saveVisibleModelRefs(modelRefs: readonly string[]): Promise<void> {
    const save = performVisibleModelRefsSave(modelRefs);
    visibleModelsSavePromise = save;
    try {
      await save;
    } finally {
      if (visibleModelsSavePromise === save) visibleModelsSavePromise = null;
    }
  }

  async function performVisibleModelRefsSave(modelRefs: readonly string[]): Promise<void> {
    let document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "pix" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = updateVisibleModelRefsInPixConfig(document.content, modelRefs);
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>(
        "write_user_config_if_unchanged",
        { kind: "pix", expectedContent: document.content, content },
      );
      if (result.written) {
        visibleModelRefs = visibleModelRefsFromPixConfig(result.document.content) ?? [...modelRefs];
        return;
      }
      document = result.document;
    }
    throw new Error("Pix settings changed repeatedly while model visibility was being saved. Try again.");
  }

  function configChangeInProgress(sessionId: string): boolean {
    return changingConfigBySessionId.has(sessionId);
  }

  function beginSessionConfigChange(sessionId: string, value: string): number {
    const generation = (configChangeGenerations.get(sessionId) ?? 0) + 1;
    configChangeGenerations.set(sessionId, generation);
    const next = new Map(changingConfigBySessionId);
    next.set(sessionId, value);
    changingConfigBySessionId = next;
    return generation;
  }

  function endSessionConfigChange(sessionId: string, generation: number): void {
    if (configChangeGenerations.get(sessionId) !== generation) return;
    const next = new Map(changingConfigBySessionId);
    next.delete(sessionId);
    changingConfigBySessionId = next;
  }

  function sessionConfigChangeIsCurrent(sessionId: string, generation: number): boolean {
    return configChangeGenerations.get(sessionId) === generation;
  }

  async function applyModelThinkingSelection(modelRef: string, thinkingLevel: string): Promise<void> {
    const requestClient = client;
    const sessionId = modelThinkingPickerSessionId;
    if (!requestClient || !sessionId || configChangeInProgress(sessionId) || operationRunning || promptRunning) {
      throw new Error("Model and thinking settings are unavailable right now.");
    }

    let options = configOptionsBySessionId.get(sessionId)
      ?? (sessionId === activeSessionId ? configOptions : []);
    const initial = modelThinkingConfigState(options);
    const selectedModel = initial.models.find((model) => model.ref === modelRef);
    if (!selectedModel) throw new Error(`Unknown model: ${modelRef}`);
    if (!selectedModel.thinkingLevels.includes(thinkingLevel)) {
      throw new Error(`${selectedModel.name} does not support ${thinkingLevel} thinking.`);
    }

    const configGeneration = beginSessionConfigChange(sessionId, "model-thinking");
    try {
      let state = modelThinkingConfigState(options);
      if (state.currentModel?.ref !== modelRef) {
        const modelOption = options.find((option) => option.id === "model" && option.type === "select");
        if (!modelOption || modelOption.type !== "select") throw new Error("Model selection is unavailable.");
        options = (await requestClient.setConfigOption(sessionId, modelOption, modelRef)).configOptions;
        if (
          requestClient !== client
          || !runtimeReadySessionIds.has(sessionId)
          || !sessionConfigChangeIsCurrent(sessionId, configGeneration)
        ) return;
        configOptionsBySessionId.set(sessionId, options);
        if (requestClient === client && sessionId === activeSessionId) configOptions = options;
        state = modelThinkingConfigState(options);
      }

      const effectiveThinking = clampThinkingLevel(thinkingLevel, state.currentThinkingLevels);
      if (state.currentThinking !== effectiveThinking) {
        const thinkingOption = options.find((option) => option.id === "thought_level" && option.type === "select");
        if (!thinkingOption || thinkingOption.type !== "select") throw new Error("Thinking selection is unavailable.");
        options = (await requestClient.setConfigOption(sessionId, thinkingOption, effectiveThinking)).configOptions;
        if (
          requestClient !== client
          || !runtimeReadySessionIds.has(sessionId)
          || !sessionConfigChangeIsCurrent(sessionId, configGeneration)
        ) return;
        configOptionsBySessionId.set(sessionId, options);
        if (requestClient === client && sessionId === activeSessionId) configOptions = options;
      }
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
      throw error;
    } finally {
      endSessionConfigChange(sessionId, configGeneration);
    }
  }

  async function enhancePromptDraft(initialDraft: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady) return;

    let draft = initialDraft.trim();
    if (!draft) {
      draft = await requestLocalTextInput(
        "Enter the prompt draft to improve. The enhanced text will be returned to the composer without sending it.",
        "Prompt draft",
      ) ?? "";
    }
    if (!draft) return;

    operationRunning = true;
    errorMessage = null;
    try {
      const enhanced = await requestClient.enhancePrompt(sessionId, draft);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      promptText = enhanced;
    } catch (error) {
      reportError(error);
    } finally {
      if (requestClient === client && sessionId === activeSessionId) operationRunning = false;
    }
  }

  async function chooseImportSession(): Promise<void> {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Import Pix session",
      filters: [{ name: "Pix session", extensions: ["jsonl"] }],
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected === "string") await importConversationPath(selected);
  }

  async function importConversationPath(path: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady || operationRunning || promptRunning) return;
    operationRunning = true;
    errorMessage = null;
    try {
      const response = await requestClient.importSession(sessionId, path);
      if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
      transcript = emptyTranscript;
      transcriptBySessionId.delete(sessionId);
      configOptions = response.configOptions;
      markSessionRuntimeReady(sessionId, response.configOptions);
      const generation = beginSessionHistoryLoad();
      await hydrateSessionHistory(requestClient, sessionId, requestWorkspace, generation);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      transcript = appendLocalSystemMessage(transcript, `Imported session from ${path}`, `local:${++localMessageId}`);
      transcriptBySessionId.set(sessionId, transcript);
      void refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      if (requestClient === client && sessionId === activeSessionId) operationRunning = false;
    }
  }

  async function openJumpPicker(query: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady) return;
    try {
      const messages = await requestClient.forkMessages(sessionId);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      const items: CommandPickerItem[] = messages.map((message) => ({
          id: `jump:${message.entryId}`,
          value: message.entryId,
          label: compactPickerText(message.text, 110),
          description: message.entryId,
        }));
      commandPicker = listCommandPickerState("jump", items, query);
    } catch (error) {
      reportError(error);
    }
  }

  async function jumpToUserMessage(entryId: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady) return;
    try {
      const messages = await requestClient.forkMessages(sessionId);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      let visibleId = transcriptUserEntryId(messages, entryId, transcript);
      if (!visibleId) {
        const history = await requestClient.sessionHistory(sessionId, true);
        if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
        let loaded = applySessionUpdates(emptyTranscript, history.updates);
        loaded = markDeferredToolResults(loaded, history.deferredToolCallIds);
        const systemItems = transcript.items.filter((item) => item.type === "message" && item.role === "system");
        transcript = systemItems.length > 0 ? { items: [...loaded.items, ...systemItems] } : loaded;
        transcriptBySessionId.set(sessionId, transcript);
        visibleId = transcriptUserEntryId(messages, entryId, transcript);
      }
      if (!visibleId) throw new Error("Could not locate that user message in the loaded session history.");
      await tick();
      scrollToTranscriptEntry(visibleId);
    } catch (error) {
      reportError(error);
    }
  }

  function transcriptUserEntryId(
    messages: readonly { entryId: string; text: string }[],
    targetEntryId: string,
    state: TranscriptState,
  ): string | undefined {
    const users = state.items.filter((item): item is MessageItem => item.type === "message" && item.role === "user");
    const targetIndex = messages.findIndex((message) => message.entryId === targetEntryId);
    if (targetIndex >= 0 && users.length === messages.length) return users[targetIndex]?.id;
    let userIndex = 0;
    for (const message of messages) {
      const target = normalizedPromptText(message.text);
      let matchIndex = -1;
      for (let index = userIndex; index < users.length; index += 1) {
        if (normalizedPromptText(users[index]!.text) === target) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) continue;
      const visible = users[matchIndex]!;
      userIndex = matchIndex + 1;
      if (message.entryId === targetEntryId) return visible.id;
    }
    return undefined;
  }

  async function openHistoryPicker(query: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady) return;
    try {
      const entries = await requestClient.requestHistory(sessionId);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      const items: CommandPickerItem[] = entries.map((entry, index) => ({
        id: `history:${index}`,
        value: entry,
        label: compactPickerText(entry, 120),
        description: entry.includes("\n") ? compactPickerText(entry.replace(/\n+/gu, " ↵ "), 180) : undefined,
      }));
      commandPicker = listCommandPickerState("history", items, query);
    } catch (error) {
      reportError(error);
    }
  }

  function showDesktopHotkeys(): void {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    transcript = appendLocalSystemMessage(
      transcript,
      [
        "Keyboard shortcuts",
        "Enter: send message / accept selected slash command",
        "Shift+Enter: insert a newline",
        "While Pix is responding, Enter queues the draft as steering for the next turn",
        "Pause button or /queue <message>: hold a message until you send it from the queue panel",
        "Tab: accept the selected slash command or inline autocomplete",
        "Esc: close the active slash menu, picker, or dialog",
        "Up/Down: move through slash-command and picker results",
        `${desktopCommandShortcutLabel("application.commandPalette", desktopShortcutPlatform)}: open the command palette`,
        `${desktopCommandShortcutLabel("session.new", desktopShortcutPlatform)}: open a fresh conversation tab`,
        "Left/Right on the tab strip: move keyboard focus between conversation tabs",
        "Home/End on the tab strip: move focus to the first/last conversation tab",
        "Delete on a focused conversation tab: close that tab",
        "/new_tab: open a fresh conversation tab",
        "/search: search saved conversations",
        "/jump: jump to a visible previous user message",
        "/history: restore a previous prompt into the composer",
      ].join("\n"),
      `local:${++localMessageId}`,
    );
    transcriptBySessionId.set(sessionId, transcript);
    scheduleScrollToLatest();
  }

  async function requestLocalTextInput(message: string, title: string): Promise<string | undefined> {
    const response = await requestElicitation({
      mode: "form",
      sessionId: activeSessionId ?? "local",
      message,
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string", title } },
        required: ["value"],
      },
    } as unknown as CreateElicitationRequest);
    if (response.action !== "accept") return undefined;
    const content = (response as { content?: Record<string, unknown> | null }).content;
    const value = content?.value;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  function scrollToTranscriptEntry(entryId: string): void {
    const target = transcriptPane?.querySelector<HTMLElement>(`[data-transcript-entry-id="${CSS.escape(entryId)}"]`);
    if (!target) return;
    transcriptFollowsLatest = false;
    if (transcriptScrollFrame) {
      cancelAnimationFrame(transcriptScrollFrame);
      transcriptScrollFrame = 0;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function normalizedPromptText(value: string): string {
    return value.replace(/\s+/gu, " ").trim();
  }

  function compactPickerText(value: string, maxLength: number): string {
    const compact = normalizedPromptText(value);
    return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
  }

  async function reloadResources(options: { echo?: boolean } = {}): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady || operationRunning || promptRunning || sessionHistoryLoading) return;
    closeProjectSelector();
    closeSessionSelector();
    commandPicker = null;
    operationRunning = true;
    activeSessionRuntimeReady = false;
    errorMessage = null;
    if (options.echo !== false) {
      transcript = appendLocalUserMessage(transcript, "/reload", `local:${++localMessageId}`, [], { localOnly: true });
      transcriptBySessionId.set(sessionId, transcript);
      await scrollToLatest();
    }
    try {
      const response = await requestClient.reloadSession(sessionId);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      configOptions = response.configOptions;
      markSessionRuntimeReady(sessionId, response.configOptions);
      void refreshSessions();
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) {
        forgetSessionRuntime(sessionId);
        reportError(error);
      }
    } finally {
      if (requestClient === client && sessionId === activeSessionId) operationRunning = false;
    }
  }

  async function resumeConversationPath(path: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady || operationRunning || promptRunning) return;
    operationRunning = true;
    errorMessage = null;
    try {
      const response = await requestClient.resumeSessionPath(sessionId, path);
      if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
      transcript = emptyTranscript;
      transcriptBySessionId.delete(sessionId);
      configOptions = response.configOptions;
      markSessionRuntimeReady(sessionId, response.configOptions);
      const generation = beginSessionHistoryLoad();
      await hydrateSessionHistory(requestClient, sessionId, requestWorkspace, generation);
      if (requestClient !== client || sessionId !== activeSessionId) return;
      transcript = appendLocalSystemMessage(transcript, `Resumed session ${path}`, `local:${++localMessageId}`);
      transcriptBySessionId.set(sessionId, transcript);
      void refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      if (requestClient === client && sessionId === activeSessionId) operationRunning = false;
    }
  }

  async function applyModelSlashCommand(value: string): Promise<void> {
    const parsed = parseDesktopModelRef(value);
    if (!parsed) {
      reportError(new Error("Model must use provider/model[:thinking] format."));
      return;
    }
    try {
      await setConfigValue("model", parsed.modelRef);
      if (parsed.thinking) await setConfigValue("thought_level", parsed.thinking);
      await reloadResources({ echo: false });
    } catch (error) {
      reportError(error);
    }
  }

  async function applyThinkingSlashCommand(level: string): Promise<void> {
    try {
      await setConfigValue("thought_level", level);
    } catch (error) {
      reportError(error);
    }
  }

  async function setConfigValue(configId: string, value: string): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const option = configOptions.find((candidate) => candidate.id === configId);
    if (!requestClient || !sessionId || !option) throw new Error(`/${configId === "model" ? "model" : "thinking"} is unavailable.`);
    const validValues = option.type === "select"
      ? option.options.flatMap((entry) => "options" in entry ? entry.options.map((item) => item.value) : [entry.value])
      : [];
    if (option.type !== "select" || !validValues.includes(value)) {
      throw new Error(`Unknown ${configId === "model" ? "model" : "thinking level"}: ${value}`);
    }
    const options = (await requestClient.setConfigOption(sessionId, option, value)).configOptions;
    configOptionsBySessionId.set(sessionId, options);
    if (requestClient === client && sessionId === activeSessionId) configOptions = options;
  }

  async function refreshAutocompleteSettings(sessionId: string): Promise<void> {
    const requestClient = client;
    if (!requestClient || sessionId !== activeSessionId) return;
    const settings = await requestClient.autocompleteSettings(sessionId).catch(() => undefined);
    if (!settings || requestClient !== client || sessionId !== activeSessionId) return;
    autocompleteEnabled = settings.enabled;
    autocompleteDebounceMs = settings.debounceMs;
  }

  function parseDesktopModelRef(value: string): { modelRef: string; thinking?: string } | null {
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return null;
    const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const colon = trimmed.lastIndexOf(":");
    if (colon <= slash) return { modelRef: trimmed };
    const suffix = trimmed.slice(colon + 1).toLowerCase();
    if (!thinkingLevels.has(suffix)) return null;
    return { modelRef: trimmed.slice(0, colon), thinking: suffix };
  }

  async function forkConversation(
    requestedEntryId?: string,
    options: { keepSourceOpen?: boolean } = {},
  ): Promise<void> {
    const requestClient = client;
    const sourceSessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sourceSessionId || !activeSessionRuntimeReady || operationRunning || promptRunning || sessionHistoryLoading) return;
    closeProjectSelector();
    closeSessionSelector();
    commandPicker = null;
    operationRunning = true;
    errorMessage = null;
    let forkedSessionId: string | undefined;
    let sourceClosed = false;
    try {
      let entryId = requestedEntryId;
      if (!entryId) {
        const messages = await requestClient.forkMessages(sourceSessionId);
        entryId = messages.at(-1)?.entryId;
      }
      if (!entryId) throw new Error("No user messages to fork from.");

      const forked = await requestClient.forkSession(sourceSessionId, requestWorkspace, entryId);
      forkedSessionId = forked.sessionId;
      if (requestClient !== client || sourceSessionId !== activeSessionId || requestWorkspace !== workspace) return;

      transcriptBySessionId.set(sourceSessionId, transcript);
      if (!options.keepSourceOpen) {
        await requestClient.closeSession(sourceSessionId);
        sourceClosed = true;
        forgetSessionRuntime(sourceSessionId);
        clearSessionActivity(sourceSessionId);
      }
      activeSessionId = forked.sessionId;
      transcript = emptyTranscript;
      configOptions = forked.configOptions;
      markSessionRuntimeReady(forked.sessionId, forked.configOptions);

      const historyGeneration = beginSessionHistoryLoad();
      void hydrateSessionHistory(requestClient, forked.sessionId, requestWorkspace, historyGeneration);
      if (!options.keepSourceOpen) {
        closedSessionTabs = [...new Set([...closedSessionTabs, sourceSessionId])];
        locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((id) => id !== sourceSessionId);
      }
      showSessionTab(forked.sessionId);
      rememberActiveSession(requestWorkspace, forked.sessionId);
      transcript = appendLocalSystemMessage(
        transcript,
        `Forked from entry ${entryId}.`,
        `local:${++localMessageId}`,
      );
      transcriptBySessionId.set(forked.sessionId, transcript);
      promptText = forked.selectedText ?? "";
      void refreshSessions();
      await scrollToLatest();
    } catch (error) {
      if (requestClient !== client || requestWorkspace !== workspace) return;
      if (options.keepSourceOpen && forkedSessionId && activeSessionId !== forkedSessionId) {
        await requestClient.closeSession(forkedSessionId).catch(() => {});
        forgetSessionRuntime(forkedSessionId);
      }
      if (sourceClosed) {
        if (forkedSessionId) {
          await requestClient.closeSession(forkedSessionId).catch(() => {});
          forgetSessionRuntime(forkedSessionId);
        }
        activeSessionId = sourceSessionId;
        activeSessionRuntimeReady = false;
        transcript = emptyTranscript;
        configOptions = [];
        try {
          const historyGeneration = beginSessionHistoryLoad();
          void hydrateSessionHistory(requestClient, sourceSessionId, requestWorkspace, historyGeneration);
          const restored = await requestClient.loadSession(sourceSessionId, requestWorkspace);
          configOptions = restored.configOptions ?? [];
          markSessionRuntimeReady(sourceSessionId, configOptions);
          rememberActiveSession(requestWorkspace, sourceSessionId);
        } catch (restoreError) {
          cancelSessionHistoryLoad();
          activeSessionId = null;
          reportError(new Error(
            `${error instanceof Error ? error.message : String(error)}; source conversation restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          ));
          return;
        }
      }
      reportError(error);
    } finally {
      if (requestClient === client && requestWorkspace === workspace) operationRunning = false;
    }
  }

  type UserMessageContextAction = "copy" | "fork" | "fork-new-tab" | "undo";

  async function resolveUserMessageSessionEntryId(message: MessageItem): Promise<string> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || message.localOnly) {
      throw new Error("This message is not backed by a Pi session entry.");
    }
    if (message.sessionEntryId) return message.sessionEntryId;

    const branchMessages = await requestClient.branchUserMessages(sessionId);
    if (requestClient !== client || sessionId !== activeSessionId) {
      throw new Error("The active conversation changed while resolving the message.");
    }
    const visibleUsers = transcript.items.filter(
      (item): item is MessageItem => item.type === "message" && item.role === "user" && !item.localOnly,
    );
    const visibleIndex = visibleUsers.findIndex((item) => item.id === message.id);
    if (visibleIndex < 0) throw new Error("User message is no longer visible.");

    // Initial Desktop history may be a persisted tail rather than the entire
    // conversation. The visible session-backed user rows are therefore a
    // suffix of the active Pi branch. Align by order, never by message text,
    // so repeated prompts remain unambiguous.
    const offset = branchMessages.length - visibleUsers.length;
    if (offset < 0) throw new Error("Could not resolve this message on the active session branch.");
    const resolved = branchMessages[offset + visibleIndex];
    if (!resolved) throw new Error("Could not resolve this message on the active session branch.");
    return resolved.entryId;
  }

  async function runUserMessageContextAction(
    message: MessageItem,
    action: UserMessageContextAction,
  ): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    const requestWorkspace = workspace;
    if (!requestClient || !sessionId) return;
    let ownsUndoOperation = false;

    if (action === "copy" && message.localOnly) {
      try {
        await navigator.clipboard.writeText(message.text);
      } catch (error) {
        reportError(error);
      }
      return;
    }

    try {
      const entryId = await resolveUserMessageSessionEntryId(message);
      if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
      if (action === "copy") {
        await requestClient.userMessageAction(sessionId, entryId, "copy");
        return;
      }
      if (action === "fork") {
        await forkConversation(entryId);
        return;
      }
      if (action === "fork-new-tab") {
        await forkConversation(entryId, { keepSourceOpen: true });
        return;
      }
      if (!activeSessionRuntimeReady || operationRunning || promptRunning || sessionHistoryLoading) return;

      operationRunning = true;
      ownsUndoOperation = true;
      errorMessage = null;
      const result = await requestClient.userMessageAction(sessionId, entryId, "undo");
      if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
      if (result.status === "cancelled") return;

      const history = await requestClient.sessionHistory(sessionId, true);
      if (requestClient !== client || sessionId !== activeSessionId || requestWorkspace !== workspace) return;
      let loaded = applySessionUpdates(emptyTranscript, history.updates);
      loaded = markDeferredToolResults(loaded, history.deferredToolCallIds);
      const summary = result.status === "warning"
        ? `Session rewound, but workspace revert had conflicts.\n\n${result.warning ?? "Some recorded mutations could not be reverted safely."}`
        : `Undid changes from entry ${entryId}. Reverted ${result.revertedChanges ?? 0} recorded command${result.revertedChanges === 1 ? "" : "s"} across ${result.changedFiles ?? 0} file${result.changedFiles === 1 ? "" : "s"}.`;
      transcript = appendLocalSystemMessage(loaded, summary, `local:${++localMessageId}`);
      transcriptBySessionId.set(sessionId, transcript);
      promptText = result.editorText ?? message.text;
      promptAttachments = [];
      invalidateAttachmentDraft();
      void refreshSessions();
      await scrollToLatest();
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId && requestWorkspace === workspace) reportError(error);
    } finally {
      if (ownsUndoOperation && requestClient === client && sessionId === activeSessionId && requestWorkspace === workspace) {
        operationRunning = false;
      }
    }
  }

  function autocompletePrompt(draft: string, signal: AbortSignal): Promise<string> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || status !== "ready" || !activeSessionRuntimeReady) return Promise.resolve("");
    return requestClient.autocomplete(sessionId, draft, signal);
  }

  async function cancelPrompt(): Promise<void> {
    if (!client || !activeSessionId || !promptRunning) return;
    try {
      await client.cancel(activeSessionId);
    } catch (error) {
      reportError(error);
    }
  }

  async function pauseAgent(): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (
      !requestClient
      || !sessionId
      || !activeSessionRuntimeReady
      || !promptRunning
      || activeAgentControlState === "pause-requested"
      || activeAgentControlState === "resuming"
    ) return;

    errorMessage = null;
    setLocalAgentControlState(sessionId, "pause-requested");
    try {
      const state = await requestClient.agentControl(sessionId, "pause");
      if (requestClient === client && runtimeReadySessionIds.has(sessionId)) {
        setLocalAgentControlState(sessionId, state.state);
      }
    } catch (error) {
      if (requestClient === client && runtimeReadySessionIds.has(sessionId)) {
        const state = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setLocalAgentControlState(sessionId, state?.state ?? "idle");
        if (sessionId === activeSessionId) reportError(error);
      }
    }
  }

  async function continueAgent(): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (
      !requestClient
      || !sessionId
      || !activeSessionRuntimeReady
      || operationRunning
      || promptRunning
      || (activeAgentControlState !== "paused" && activeAgentControlState !== "continuable")
    ) return;

    errorMessage = null;
    promptEndedAtBySessionId.delete(sessionId);
    setLocalAgentControlState(sessionId, "resuming");
    setSessionPromptRunning(sessionId, true);
    try {
      const state = await requestClient.agentControl(sessionId, "continue");
      if (requestClient === client && runtimeReadySessionIds.has(sessionId)) {
        setLocalAgentControlState(sessionId, state.state);
      }
    } catch (error) {
      if (requestClient === client && runtimeReadySessionIds.has(sessionId)) {
        const state = await requestClient.agentControl(sessionId, "state").catch(() => undefined);
        setLocalAgentControlState(sessionId, state?.state ?? "idle");
        if (sessionId === activeSessionId) reportError(error);
      }
    } finally {
      if (requestClient === client) {
        const endedAtMs = Date.now();
        promptEndedAtBySessionId.set(sessionId, endedAtMs);
        setSessionPromptRunning(sessionId, false);
        finalizeSessionTranscriptActivity(sessionId, endedAtMs);
        queueMicrotask(() => void flushAutoQueue(sessionId));
      }
    }
  }

  async function setConfig(option: SessionConfigOption, value: string | boolean): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady || configChangeInProgress(sessionId)) return;
    const configGeneration = beginSessionConfigChange(sessionId, option.id);
    try {
      const options = (await requestClient.setConfigOption(sessionId, option, value)).configOptions;
      if (
        requestClient !== client
        || !runtimeReadySessionIds.has(sessionId)
        || !sessionConfigChangeIsCurrent(sessionId, configGeneration)
      ) return;
      configOptionsBySessionId.set(sessionId, options);
      if (sessionId === activeSessionId) configOptions = options;
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      endSessionConfigChange(sessionId, configGeneration);
    }
  }

  function replacePendingElicitation(pending: PendingElicitation): void {
    if (pending.sessionId === null) {
      if (pendingUnscopedElicitation?.resolve === pending.resolve) pendingUnscopedElicitation = pending;
      return;
    }
    if (pendingElicitationsBySession.get(pending.sessionId)?.resolve !== pending.resolve) return;
    const next = new Map(pendingElicitationsBySession);
    next.set(pending.sessionId, pending);
    pendingElicitationsBySession = next;
  }

  function removePendingElicitation(pending: PendingElicitation): void {
    if (pending.sessionId === null) {
      if (pendingUnscopedElicitation?.resolve === pending.resolve) pendingUnscopedElicitation = null;
      return;
    }
    if (pendingElicitationsBySession.get(pending.sessionId)?.resolve !== pending.resolve) return;
    const next = new Map(pendingElicitationsBySession);
    next.delete(pending.sessionId);
    pendingElicitationsBySession = next;
  }

  function pendingQuestionForRequestId(requestId: number): PendingQuestionElicitation | null {
    if (pendingUnscopedElicitation?.kind === "question" && pendingUnscopedElicitation.requestId === requestId) {
      return pendingUnscopedElicitation;
    }
    for (const pending of pendingElicitationsBySession.values()) {
      if (pending.kind === "question" && pending.requestId === requestId) return pending;
    }
    return null;
  }

  function cancelAllPendingElicitations(): void {
    const pending = [
      ...(pendingUnscopedElicitation ? [pendingUnscopedElicitation] : []),
      ...pendingElicitationsBySession.values(),
    ];
    pendingUnscopedElicitation = null;
    pendingElicitationsBySession = new Map();
    cancelQuestionImageOperation();
    for (const item of pending) item.resolve({ action: "cancel" });
  }

  function requestElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const question = parseQuestionElicitation(request);
    const field = parseElicitation(request);
    if (!question && !field) return Promise.resolve({ action: "cancel" });
    const ownerSessionId = elicitationSessionId(request);
    if (!canAcceptElicitationForSession(
      ownerSessionId,
      new Set(pendingElicitationsBySession.keys()),
      pendingUnscopedElicitation !== null,
    )) {
      return Promise.resolve({ action: "cancel" });
    }

    return new Promise((resolve) => {
      const pending: PendingElicitation = question
        ? {
            kind: "question",
            sessionId: ownerSessionId,
            requestId: ++elicitationSequence,
            message: question.message,
            questions: question.questions,
            state: createQuestionnaireState(question.questions),
            resolve,
          }
        : { kind: "form", sessionId: ownerSessionId, message: request.message, field: field!, resolve };
      if (ownerSessionId === null) {
        pendingUnscopedElicitation = pending;
      } else {
        const next = new Map(pendingElicitationsBySession);
        next.set(ownerSessionId, pending);
        pendingElicitationsBySession = next;
      }
    });
  }

  function updateQuestionnaire(state: QuestionnaireState, requestId?: number): void {
    const pending = activePendingElicitation;
    if (
      !pending
      || pending.kind !== "question"
      || (requestId !== undefined && pending.requestId !== requestId)
    ) return;
    replacePendingElicitation({ ...pending, state });
  }

  function updateElicitationValue(value: string | boolean): void {
    const pending = activePendingElicitation;
    if (!pending || pending.kind !== "form") return;
    replacePendingElicitation({
      ...pending,
      field: { ...pending.field, value },
    });
  }

  function answerElicitation(accepted: boolean): void {
    const pending = activePendingElicitation;
    if (!pending || pending.kind !== "form") return;
    removePendingElicitation(pending);
    pending.resolve(accepted
      ? { action: "accept", content: { [pending.field.key]: pending.field.value } }
      : { action: "cancel" });
  }

  function answerQuestion(state: QuestionnaireState, requestId: number): void {
    const pending = pendingQuestionForRequestId(requestId);
    if (!pending) return;
    const selections = createQuestionSelections(state, pending.questions);
    if (!selections) return;
    removePendingElicitation(pending);
    cancelQuestionImageOperation(requestId);
    pending.resolve(createQuestionAcceptResponse(selections));
  }

  function cancelElicitation(requestId: number): void {
    const pending = pendingQuestionForRequestId(requestId);
    if (!pending) return;
    removePendingElicitation(pending);
    cancelQuestionImageOperation(requestId);
    pending.resolve({ action: "cancel" });
  }

  function cancelPendingElicitationForSession(sessionId: string): void {
    const pending = pendingElicitationsBySession.get(sessionId);
    if (!pending) return;
    const next = new Map(pendingElicitationsBySession);
    next.delete(sessionId);
    pendingElicitationsBySession = next;
    if (pending.kind === "question") cancelQuestionImageOperation(pending.requestId);
    pending.resolve({ action: "cancel" });
  }

  function reportError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  async function scrollToLatest(): Promise<void> {
    if (!transcriptFollowsLatest) return;
    await tick();
    if (!transcriptFollowsLatest) return;
    const pane = transcriptPane;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }

</script>

<svelte:window onkeydown={handleApplicationKeydown} />
<svelte:head><title>Pix Desktop</title></svelte:head>

<div class="grid h-full grid-rows-[36px_minmax(0,1fr)_28px] bg-background text-foreground">
  <header
    class="flex min-w-0 select-none items-stretch border-b border-border bg-window-titlebar text-chrome-foreground"
    data-tauri-drag-region
  >
    <div class={["shrink-0", isMacOS ? "w-[76px]" : "w-3"]} data-tauri-drag-region></div>

    <div class="relative flex min-w-0 flex-1" data-tauri-drag-region>
      <SessionTabs
        sessions={titlebarSessions}
        activeSessionId={activeConversationTabId}
        {runningSessionIds}
        activityBySessionId={sessionActivityBySessionId}
        needsInputSessionIds={pendingElicitationSessionIds}
        disabled={sessionMutationRunning}
        canCreate={canUseSession}
        newSessionShortcut={desktopCommandShortcutLabel("session.new", desktopShortcutPlatform)}
        onTabClick={handleSessionTabClick}
        onCloseTab={(sessionId) => closeSessionTab(sessionId)}
        onCreate={() => void openSessionStartTab()}
      />

      {#if sessionSelectorOpen}
        <SessionSelector
          {sessions}
          {activeSessionId}
          {activeTitle}
          initialQuery={sessionSelectorQuery}
          mode={sessionSelectorMode}
          canCreate={sessionSelectorMode === "open" && canUseSession}
          disabled={sessionMutationRunning}
          onCreate={() => void openSessionStartTab()}
          onSelect={sessionSelectorMode === "delete" ? (sessionId) => void deleteSelectedSession(sessionId) : selectSession}
          onClose={closeSessionSelector}
        />
      {/if}
    </div>
  </header>

  <div class="flex min-h-0 min-w-0">
    <WorkspaceSidebar
      bind:this={workspaceSidebar}
      {workspace}
      tasks={taskDocument.tasks}
      loading={tasksLoading}
      saving={tasksSaving}
      storageError={taskLoadFailed}
      taskStorageIndicatorError={taskSaveError}
      activeTaskId={taskActionId}
      sessionReady={canUseSession}
      registrySnapshot={activeRegistrySnapshot}
      {registryLoading}
      {registryActionId}
      {gitSnapshot}
      {gitLoading}
      {gitError}
      {gitActionId}
      {gitLlmActionId}
      {projectDocuments}
      {recentProjects}
      {projectColors}
      projectSwitchDisabled={anyPromptRunning || sessionMutationRunning || tasksSaving || taskActionId !== null}
      externalEditorLabel={externalEditorDisplayName}
      onCreate={createProjectTask}
      onUpdate={updateProjectTask}
      onStatusChange={updateProjectTaskStatus}
      onChooseTaskAttachments={chooseTaskAttachments}
      onPasteTaskAttachments={pasteTaskAttachments}
      onOpenTaskAttachment={(attachment) => void activateAttachment(attachment)}
      onDelete={deleteProjectTask}
      onReorder={reorderProjectTask}
      onRun={(task) => void runProjectTask(task)}
      onOpenSession={(task) => void openProjectTaskSession(task)}
      onOpenProjectDocument={openProjectDocument}
      onListProjectDirectory={listProjectDirectory}
      onValidateProjectFile={validateProjectFile}
      onOpenProjectFile={(path, range) => void openProjectFile(path, "replace", range)}
      onOpenExternalEditor={(path) => void openInExternalEditor(path)}
      onProjectSwitcherOpen={prepareProjectSwitcher}
      onSelectProject={(path) => void selectWorkspace(path)}
      onOpenProjectInNewWindow={openWorkspaceInNewWindow}
      onChooseWorkspace={() => void chooseWorkspace()}
      onChooseWorkspaceInNewWindow={() => void chooseWorkspaceInNewWindow()}
      onSaveProjectColor={saveProjectColor}
      onReload={() => void loadProjectTasks(workspace)}
      onRegistryRefresh={refreshRegistry}
      onRegistryAction={(request, actionId) => void runRegistryAction(request, actionId)}
      onGitRefresh={() => void refreshGit()}
      onGitOpenDiff={(path, scope) => void openGitDiff(path, scope)}
      onGitStage={stageGitPath}
      onGitUnstage={unstageGitPath}
      onGitCommit={commitGit}
      onGitPush={pushGit}
      onGitSwitchBranch={switchGitBranch}
      onGitCreateBranch={createGitBranch}
      onGitGenerateCommitMessage={generateGitCommitMessage}
      onGitReview={(path, scope) => void reviewGitDiff(path, scope)}
      onRefreshKnowledge={() => void refreshKnowledgeBaseInNewSession()}
    />

    <div class="relative flex min-h-0 min-w-0 flex-1">
      <div id="conversation-workspace" class="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] bg-background">
        {#if workspaceEditorTabs.length > 1}
          <WorkspaceEditorTabs
            tabs={workspaceEditorTabs}
            activeId={activeWorkspaceEditor}
            onSelect={selectWorkspaceEditor}
            onClose={closeWorkspaceEditor}
            onFallbackFocus={(id) => {
              if (id === "conversation") void promptComposer?.focus();
            }}
          />
        {/if}

        <div class="relative row-start-2 grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden">
      <main
        id="workspace-editor-panel-conversation"
        class={[
          "col-start-1 row-start-1 min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-background",
          activeWorkspaceEditor === "conversation" ? "grid" : "hidden",
        ]}
        role={workspaceEditorTabs.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={workspaceEditorTabs.length > 1 ? "workspace-editor-tab-conversation" : undefined}
      >
        {#if errorMessage}
          <ErrorBanner
            message={errorMessage}
            canReconnect={status === "error"}
            onReconnect={() => void reconnect()}
            onDismiss={() => errorMessage = null}
          />
        {/if}

        {#if sessionStartOpen}
          <div class="row-start-2 min-h-0 min-w-0">
            <SessionStartView
              sessions={sessionStartCandidates}
              onSelect={(sessionId) => void selectSessionFromDraft(sessionId)}
            />
          </div>
        {:else}
          <TranscriptPane
            {transcript}
            {activeSessionId}
            {workspace}
            {promptRunning}
            {operationRunning}
            historyLoading={sessionHistoryLoading}
            bind:pane={transcriptPane}
            bind:content={transcriptContent}
            showScrollToBottom={!transcriptFollowsLatest}
            onScroll={handleTranscriptScroll}
            onScrollToBottom={jumpToLatest}
            onChooseWorkspace={() => void chooseWorkspace()}
            onOpenAttachment={(attachment) => void activateAttachment(attachment)}
            onPrepareAttachment={prepareTranscriptAttachment}
            onValidateProjectFile={validateProjectFile}
            onValidateLocalFile={validateLocalFile}
            onOpenProjectFile={(path, range) => openProjectFile(path, "replace", range)}
            onResolveProjectMedia={resolveProjectMedia}
            onOpenLocalFile={openLocalFile}
            onResolveLocalMedia={resolveLocalMedia}
            onLoadToolResult={(toolCallId) => void loadDeferredToolResult(toolCallId)}
            onUserMessageAction={(message, action) => void runUserMessageContextAction(message, action)}
          />
        {/if}

        <div class="row-start-3 min-w-0">
          <QueuedMessagesPanel
            items={activeQueueItems}
            disabled={operationRunning || queueActionRunning}
            onAction={(item, action) => void actOnQueuedMessage(item, action)}
          />
          <PromptComposer
            bind:this={promptComposer}
            bind:promptText
          attachments={promptAttachments}
          availableCommands={activeSlashCommands}
          {activeSessionId}
          draftSession={draftSessionTabActive}
          ready={status === "ready"
            && !sessionMutationRunning
            && !sessionHistoryLoading
            && (draftSessionTabActive || activeSessionRuntimeReady)}
          {promptRunning}
          agentControlState={activeAgentControlState}
          {dragActive}
          {autocompleteEnabled}
          {autocompleteDebounceMs}
          {questionMode}
          onAutocomplete={autocompletePrompt}
          onDraftChange={promoteSessionStart}
          onEnhance={() => enhancePromptDraft(promptText)}
          onSubmit={submitPrompt}
          onDefer={deferCurrentDraft}
          onCreateTask={createProjectTaskFromComposer}
          onPause={pauseAgent}
          onContinue={continueAgent}
          onCancel={cancelPrompt}
          onChooseAttachments={() => {
            promoteSessionStart();
            return chooseAttachments();
          }}
          onPasteAttachments={(files) => {
            promoteSessionStart();
            return addPastedAttachments(files);
          }}
          onRemoveAttachment={removeAttachment}
          onOpenAttachment={(attachment) => void activateAttachment(attachment)}
          />
        </div>
      </main>

          {#if activePreview}
            <div
              id="workspace-editor-panel-preview"
              class={activeWorkspaceEditor === "preview" ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
              role="tabpanel"
              aria-labelledby="workspace-editor-tab-preview"
            >
              <PreviewPane
                bind:this={previewPane}
                previewId={activePreview.id}
                scrollPosition={activePreview.scrollPosition}
                file={activePreview.kind === "file" ? activePreview.file : undefined}
                lineRange={activePreview.kind === "file" ? activePreview.lineRange : undefined}
                attachment={activePreview.kind === "attachment" ? activePreview.attachment : undefined}
                canGoBack={canGoBackInPreview}
                canGoForward={canGoForwardInPreview}
                editable={activePreview.kind === "file" && isEditableProjectMarkdown(activePreview.file.path)}
                externalEditorLabel={activePreview.kind === "file" && !activePreview.file.path.startsWith("~/")
                  ? externalEditorDisplayName
                  : undefined}
                onBack={() => movePreview(-1)}
                onForward={() => movePreview(1)}
                onOpenProjectFile={(path, range) => openProjectFile(path, "push", range)}
                onValidateProjectFile={validateProjectFile}
                onValidateLocalFile={validateLocalFile}
                onResolveProjectMedia={resolveProjectMedia}
                onOpenLocalFile={(path) => openLocalFile(path, "push")}
                onResolveLocalMedia={resolveLocalMedia}
                onSaveProjectFile={saveProjectMarkdown}
                onOpenExternalEditor={activePreview.kind === "file" && !activePreview.file.path.startsWith("~/")
                  ? (path) => void openInExternalEditor(path)
                  : undefined}
                onScrollPositionChange={rememberPreviewScroll}
                onDirtyChange={(dirty) => previewDirty = dirty}
                onClose={closePreview}
              />
            </div>
          {/if}

          {#if gitDiffPreview}
            <div
              id="workspace-editor-panel-git-diff"
              class={activeWorkspaceEditor === "git-diff" ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
              role="tabpanel"
              aria-labelledby="workspace-editor-tab-git-diff"
            >
              <GitDiffPane
                diff={gitDiffPreview}
                review={gitDiffReview}
                reviewLoading={gitLlmActionId?.startsWith("review:") === true}
                resolveLoading={gitResolveRunning}
                canReview={Boolean(client && activeSessionId && activeSessionRuntimeReady)}
                canResolve={Boolean(client && workspace && status === "ready" && !operationRunning)}
                onValidateProjectFile={validateProjectFile}
                onValidateLocalFile={validateLocalFile}
                onOpenProjectFile={(path, range) => void openProjectFile(path, "replace", range)}
                onOpenLocalFile={(path) => void openLocalFile(path)}
                onReview={() => void reviewGitDiff(gitDiffPreview?.path, gitDiffPreview?.scope ?? "all")}
                onResolve={() => void resolveGitReviewInNewSession()}
              />
            </div>
          {/if}
        </div>
      </div>

      {#if sessionInspectorOpen}
        <SessionInspector
          {activeSessionId}
          sessionTitle={activeTitle}
          summary={activeSessionActivity}
          todoSnapshot={activeTodoSnapshot}
          subagentSnapshot={activeSubagentSnapshot}
          onClose={() => setSessionInspectorOpen(false)}
        />
      {/if}
    </div>
  </div>

  <StatusBar
    {status}
    {configOptions}
    {changingConfig}
    {promptRunning}
    canConfigure={canUseSession && activeSessionRuntimeReady && !sessionHistoryLoading}
    modelThinkingOpen={modelThinkingPickerOpen}
    runtimeStatus={activeRuntimeStatus}
    {modelUsageRefreshing}
    {dcpStatsRefreshing}
    {dcpCompressionRunning}
    {dcpCompressionAvailable}
    canCompressContext={dcpCompressionAvailable && canUseSession && !!activeSessionId && activeSessionRuntimeReady && changingConfig === null && !sessionHistoryLoading && !promptRunning && activeAgentControlState === "idle"}
    canNavigateMessages={canUseSession && !!activeSessionId && activeSessionRuntimeReady && !sessionHistoryLoading}
    messageNavigationOpen={commandPicker?.command === "jump"}
    sessionActivity={activeSessionActivity}
    sessionActivityOpen={sessionInspectorOpen}
    canOpenSessionActivity={!!activeSessionId}
    sessionNeedsInput={activePendingElicitation !== null}
    commandPaletteOpen={commandPicker?.command === "commands"}
    commandPaletteShortcut={desktopCommandShortcutLabel("application.commandPalette", desktopShortcutPlatform)}
    onSetConfig={(option, value) => void setConfig(option, value)}
    onOpenModelThinking={openModelThinkingPicker}
    onRefreshModelUsage={refreshActiveModelUsage}
    onOpenDcpStats={() => void refreshActiveDcpStats()}
    onCompressDcpContext={() => void compressActiveDcpContext()}
    onNavigateMessages={() => void openJumpPicker("")}
    onToggleSessionActivity={() => setSessionInspectorOpen(!sessionInspectorOpen)}
    onOpenCommandPalette={() => void openDesktopCommandPalette()}
  />
</div>

{#if activePendingElicitation?.kind === "form"}
  <ElicitationDialog
    message={activePendingElicitation.message}
    field={activePendingElicitation.field}
    onValueChange={updateElicitationValue}
    onAnswer={answerElicitation}
  />
{/if}
{#if commandPicker}
  <CommandPicker
    picker={commandPicker}
    onSelect={(value) => void selectCommandOption(value)}
    onClose={() => commandPicker = null}
  />
{/if}

{#if modelThinkingPickerOpen}
  <ModelThinkingPicker
    {configOptions}
    {visibleModelRefs}
    disabled={!canUseSession || !activeSessionRuntimeReady || promptRunning || changingConfig !== null}
    onApply={applyModelThinkingSelection}
    onVisibleModelsChange={saveVisibleModelRefs}
    onClose={closeModelThinkingPicker}
  />
{/if}
