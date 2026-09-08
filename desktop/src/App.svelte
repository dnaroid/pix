<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
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
  } from "./lib/acp-client";
  import { TauriAcpTransport } from "./lib/tauri-transport";
  import {
    appendLocalSystemMessage,
    appendLocalUserMessage,
    applyDeferredToolResult,
    applySessionUpdates,
    emptyTranscript,
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
    listCommandPickerState,
    type CommandPickerItem,
    type CommandPickerState,
  } from "./lib/command-interactions";
  import {
    ACTIVE_SESSIONS_STORAGE_KEY,
    buildTabSessions,
    parseActiveSessionIds,
    restoredTabSessionIds,
    serializeActiveSessionIds,
    startupSessionId,
  } from "./lib/session-tabs";
  import { parseElicitation, type ElicitationField } from "./lib/elicitation";
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
    RECENT_PROJECTS_STORAGE_KEY,
    WORKSPACE_STORAGE_KEY,
  } from "./lib/recent-projects";
  import ProjectTitlebar from "./components/ProjectTitlebar.svelte";
  import SessionTabs from "./components/SessionTabs.svelte";
  import SessionSelector from "./components/SessionSelector.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import TranscriptPane from "./components/TranscriptPane.svelte";
  import PromptComposer from "./components/PromptComposer.svelte";
  import QueuedMessagesPanel from "./components/QueuedMessagesPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ElicitationDialog from "./components/ElicitationDialog.svelte";
  import CommandPicker from "./components/CommandPicker.svelte";
  import PreviewDialog from "./components/PreviewDialog.svelte";
  import WorkspaceSidebar from "./components/WorkspaceSidebar.svelte";
  import type { SessionStateNotification } from "./lib/session-state";
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
  import type { ProjectFilePreview } from "./lib/project-files";
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
    buildTaskPrompt,
    EMPTY_TASK_DOCUMENT,
    moveProjectTask,
    parseTaskDocument,
    type ProjectTask,
    type ProjectTaskDocument,
    type ProjectTaskDropPosition,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "./lib/project-tasks";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type PendingFormElicitation = {
    kind: "form";
    message: string;
    field: ElicitationField;
    resolve: (response: CreateElicitationResponse) => void;
  };
  type PendingQuestionElicitation = {
    kind: "question";
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
    | { kind: "file"; file: ProjectFilePreview }
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

  let client = $state<AcpClient | null>(null);
  let status = $state<ConnectionStatus>("starting");
  let workspace = $state("");
  let recentProjects = $state<string[]>([]);
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
  let changingConfig = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let diagnostics = $state<string[]>([]);
  let pendingElicitation = $state<PendingElicitation | null>(null);
  let commandPicker = $state<CommandPickerState | null>(null);
  let addingQuestionImages = $state(false);
  let projectSelectorOpen = $state(false);
  let sessionSelectorOpen = $state(false);
  let sessionSelectorQuery = $state("");
  let sessionSelectorMode = $state<"open" | "delete">("open");
  let sessionSelectorTrigger = $state<HTMLButtonElement | null>(null);
  let dragActive = $state(false);
  let previewHistory = $state<PreviewHistory<PreviewEntry>>(emptyPreviewHistory());
  let taskDocument = $state<ProjectTaskDocument>(EMPTY_TASK_DOCUMENT);
  let tasksLoading = $state(false);
  let tasksSaving = $state(false);
  let taskLoadFailed = $state(false);
  let taskActionId = $state<string | null>(null);
  let todoSnapshots = $state<Map<string, SessionTodoSnapshot>>(new Map());
  let subagentSnapshots = $state<Map<string, SessionSubagentSnapshot>>(new Map());
  let registrySnapshots = $state<Map<string, RegistrySnapshot>>(new Map());
  let registryActionId = $state<string | null>(null);
  let slashCommandsBySession = $state<Map<string, AvailableCommand[]>>(new Map());
  let queueItemsBySession = $state<Map<string, QueueItem[]>>(new Map());
  let queueActionRunning = $state(false);
  let imagePromptSupported = false;
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let promptComposer = $state<{ focus: () => Promise<void> } | null>(null);
  let localMessageId = 0;
  let reconnectPromise: Promise<void> | null = null;
  let sessionRefreshRequest: { client: AcpClient; workspace: string; promise: Promise<void> } | null = null;
  let sessionRefreshGeneration = 0;
  let sessionPrewarmGeneration = 0;
  let autocompleteSettingsGeneration = 0;
  let attachmentSequence = 0;
  let previewSequence = 0;
  let attachmentDraftGeneration = 0;
  let attachmentAddQueue = Promise.resolve();
  let pendingSessionUpdates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  let sessionUpdateFrame = 0;
  let transcriptScrollFrame = 0;
  let sessionHistoryGeneration = 0;
  let previousAttachmentDraftKey: string | null = null;
  let projectFilePreviewGeneration = 0;
  let taskLoadGeneration = 0;
  let elicitationSequence = 0;
  let questionImageOperationSequence = 0;
  let activeQuestionImageOperationId: number | null = null;
  const registeredAttachmentPaths = new Set<string>();
  const preparingAttachmentPaths = new Map<string, Promise<void>>();
  const preparingDeferredImages = new Map<string, Promise<void>>();
  const loadingToolResults = new Set<string>();
  const transcriptBySessionId = new Map<string, TranscriptState>();
  const runtimeReadySessionIds = new Set<string>();
  const runtimeLoadsBySessionId = new Map<string, Promise<void>>();
  const configOptionsBySessionId = new Map<string, SessionConfigOption[]>();
  const promptRunsBySessionId = new Map<string, Promise<void>>();
  const autoFlushInProgress = new Set<string>();

  const canUseSession = $derived(status === "ready" && !!workspace && !operationRunning);
  const promptRunning = $derived(activeSessionId ? runningSessionIds.has(activeSessionId) : false);
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
  const attachmentDraftKey = $derived(`${workspace}\0${activeSessionId ?? ""}`);
  const activePreview = $derived(currentPreview(previewHistory));
  const canGoBackInPreview = $derived(canMovePreviewHistory(previewHistory, -1));
  const canGoForwardInPreview = $derived(canMovePreviewHistory(previewHistory, 1));
  const activeTodoSnapshot = $derived(activeSessionId ? todoSnapshots.get(activeSessionId) : undefined);
  const activeSubagentSnapshot = $derived(activeSessionId ? subagentSnapshots.get(activeSessionId) : undefined);
  const activeRegistrySnapshot = $derived(activeSessionId ? registrySnapshots.get(activeSessionId) : undefined);
  const registryLoading = $derived(registryActionId === "refresh");
  const activeQueueItems = $derived(activeSessionId ? (queueItemsBySession.get(activeSessionId) ?? []) : []);
  const activeSlashCommands = $derived(
    mergeSlashCommands(
      DESKTOP_SLASH_COMMANDS,
      activeSessionId ? (slashCommandsBySession.get(activeSessionId) ?? []) : [],
    ),
  );
  const questionMode = $derived.by<QuestionComposerMode | undefined>(() => {
    const pending = pendingElicitation;
    if (!pending || pending.kind !== "question") return undefined;
    const requestId = pending.requestId;
    return {
      message: pending.message,
      questions: pending.questions,
      state: pending.state,
      addingImages: addingQuestionImages,
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
      previewHistory = emptyPreviewHistory();
      projectFilePreviewGeneration += 1;
    }
    previousAttachmentDraftKey = key;
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

  onMount(() => {
    let disposed = false;
    let unlistenDragDrop: (() => void) | undefined;
    restoreProjects();
    if (workspace) void loadProjectTasks(workspace);
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
        } else if (activeSessionId && !operationRunning && pendingElicitation?.kind !== "question") {
          void addAttachmentPaths(payload.paths);
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
      unlistenDragDrop?.();
      if (sessionUpdateFrame) cancelAnimationFrame(sessionUpdateFrame);
      if (transcriptScrollFrame) cancelAnimationFrame(transcriptScrollFrame);
      pendingSessionUpdates = [];
      pendingElicitation?.resolve({ action: "cancel" });
      pendingElicitation = null;
      cancelQuestionImageOperation();
      void client?.dispose();
    };
  });

  async function connect(): Promise<void> {
    status = "starting";
    errorMessage = null;
    const next = new AcpClient(new TauriAcpTransport(), {
      onSessionUpdate: handleSessionUpdate,
      onSessionState: handleSessionState,
      onQueueState: handleQueueState,
      onQueueConsumed: handleQueueConsumed,
      onElicitation: requestElicitation,
      onDiagnostic: (line) => {
        diagnostics = [...diagnostics.slice(-49), line];
      },
      onExit: (exit) => {
        if (client !== next) return;
        closeProjectSelector();
        closeSessionSelector();
        commandPicker = null;
        pendingElicitation?.resolve({ action: "cancel" });
        pendingElicitation = null;
        cancelQuestionImageOperation();
        activeSessionId = null;
        activeSessionRuntimeReady = false;
        runtimeReadySessionIds.clear();
        runtimeLoadsBySessionId.clear();
        configOptionsBySessionId.clear();
        transcriptBySessionId.clear();
        sessionPrewarmGeneration += 1;
        todoSnapshots = new Map();
        subagentSnapshots = new Map();
        registrySnapshots = new Map();
        registryActionId = null;
        slashCommandsBySession = new Map();
        queueItemsBySession = new Map();
        transcript = emptyTranscript;
        configOptions = [];
        status = exit.requested ? "stopped" : "error";
        if (!exit.requested) {
          errorMessage = exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`;
        }
        runningSessionIds = new Set();
        operationRunning = false;
        changingConfig = null;
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
    pendingElicitation?.resolve({ action: "cancel" });
    pendingElicitation = null;
    cancelQuestionImageOperation();
    activeSessionId = null;
    activeSessionRuntimeReady = false;
    runtimeReadySessionIds.clear();
    runtimeLoadsBySessionId.clear();
    configOptionsBySessionId.clear();
    transcriptBySessionId.clear();
    sessionPrewarmGeneration += 1;
    todoSnapshots = new Map();
    subagentSnapshots = new Map();
    registrySnapshots = new Map();
    registryActionId = null;
    slashCommandsBySession = new Map();
    queueItemsBySession = new Map();
    transcript = emptyTranscript;
    configOptions = [];
    runningSessionIds = new Set();
    operationRunning = false;
    changingConfig = null;
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
    pendingSessionUpdates.push({ sessionId: notification.sessionId, update });
    if (sessionUpdateFrame) return;
    sessionUpdateFrame = requestAnimationFrame(flushSessionUpdates);
  }

  function flushSessionUpdates(): void {
    sessionUpdateFrame = 0;
    const queued = pendingSessionUpdates;
    pendingSessionUpdates = [];
    if (queued.length === 0) return;

    const activeId = activeSessionId;
    const followLatest = activeId ? transcriptIsNearBottom() : false;
    const updatesBySession = new Map<string, SessionUpdate[]>();
    for (const entry of queued) {
      const updates = updatesBySession.get(entry.sessionId);
      if (updates) updates.push(entry.update);
      else updatesBySession.set(entry.sessionId, [entry.update]);
    }

    for (const [sessionId, updates] of updatesBySession) {
      const current = sessionId === activeId
        ? transcript
        : transcriptBySessionId.get(sessionId) ?? emptyTranscript;
      const nextTranscript = applySessionUpdates(current, updates);
      transcriptBySessionId.set(sessionId, nextTranscript);
      if (sessionId === activeId) transcript = nextTranscript;
    }
    if (activeId && followLatest) scheduleScrollToLatest();
  }

  function transcriptIsNearBottom(): boolean {
    const pane = transcriptPane;
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 160;
  }

  function scheduleScrollToLatest(): void {
    if (transcriptScrollFrame) return;
    transcriptScrollFrame = requestAnimationFrame(() => {
      transcriptScrollFrame = 0;
      const pane = transcriptPane;
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  function handleSessionState(notification: SessionStateNotification): void {
    const registrySnapshot = registrySnapshotFromSessionState(notification);
    if (registrySnapshot) {
      const next = new Map(registrySnapshots);
      next.set(notification.sessionId, registrySnapshot);
      registrySnapshots = next;
      return;
    }
    const todoSnapshot = sessionTodoSnapshot(notification);
    if (todoSnapshot) {
      todoSnapshots = updateSessionTodoSnapshots(todoSnapshots, notification.sessionId, todoSnapshot);
      return;
    }
    const subagentSnapshot = sessionSubagentSnapshot(notification);
    if (subagentSnapshot) {
      subagentSnapshots = updateSessionSubagentSnapshots(subagentSnapshots, notification.sessionId, subagentSnapshot);
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

  function clearSessionActivity(sessionId: string): void {
    const nextTodos = new Map(todoSnapshots);
    nextTodos.delete(sessionId);
    todoSnapshots = nextTodos;
    const nextSubagents = new Map(subagentSnapshots);
    nextSubagents.delete(sessionId);
    subagentSnapshots = nextSubagents;
    const nextCommands = new Map(slashCommandsBySession);
    nextCommands.delete(sessionId);
    slashCommandsBySession = nextCommands;
    const nextQueue = new Map(queueItemsBySession);
    nextQueue.delete(sessionId);
    queueItemsBySession = nextQueue;
    promptRunsBySessionId.delete(sessionId);
    autoFlushInProgress.delete(sessionId);
  }

  function setSessionPromptRunning(sessionId: string, running: boolean): void {
    const next = new Set(runningSessionIds);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    runningSessionIds = next;
  }

  function runPromptRequest(
    requestClient: AcpClient,
    sessionId: string,
    blocks: ContentBlock[],
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<void> {
    if (promptRunsBySessionId.has(sessionId)) {
      return Promise.reject(new Error("A prompt is already running for this conversation."));
    }
    setSessionPromptRunning(sessionId, true);
    let tracked!: Promise<void>;
    tracked = requestClient.prompt(sessionId, blocks, fileImages)
      .then(() => undefined)
      .finally(() => {
        if (promptRunsBySessionId.get(sessionId) !== tracked) return;
        promptRunsBySessionId.delete(sessionId);
        setSessionPromptRunning(sessionId, false);
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
    ) return;

    autoFlushInProgress.add(sessionId);
    try {
      while (
        requestClient === client
        && runtimeReadySessionIds.has(sessionId)
        && !runningSessionIds.has(sessionId)
      ) {
        const message = await requestClient.takeAutoMessage(sessionId);
        if (!message) return;
        appendQueuedMessageToTranscript(sessionId, message);
        try {
          await runPromptRequest(requestClient, sessionId, queuedMessageBlocks(message));
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

  function appendQueuedMessageToTranscript(sessionId: string, message: QueuedUserMessage): void {
    const messageId = `queued:${message.id}`;
    const current = sessionId === activeSessionId
      ? transcript
      : transcriptBySessionId.get(sessionId) ?? emptyTranscript;
    if (current.items.some((item) => item.type === "message" && item.id === messageId)) return;
    const draft = queuedMessageDraft(message);
    const next = appendLocalUserMessage(current, message.displayText || draft.text, messageId, draft.attachments);
    transcriptBySessionId.set(sessionId, next);
    if (sessionId === activeSessionId) {
      const followLatest = transcriptIsNearBottom();
      transcript = next;
      if (followLatest) scheduleScrollToLatest();
    }
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

    const pending = requestClient.loadSession(sessionId, requestWorkspace)
      .then((response) => {
        if (requestClient !== client || requestWorkspace !== workspace) return;
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
        if (requestClient === client && requestWorkspace === workspace && sessionId === activeSessionId) {
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
    runtimeReadySessionIds.delete(sessionId);
    runtimeLoadsBySessionId.delete(sessionId);
    configOptionsBySessionId.delete(sessionId);
    if (registrySnapshots.has(sessionId)) {
      const next = new Map(registrySnapshots);
      next.delete(sessionId);
      registrySnapshots = next;
    }
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
      if (sessionHistoryIsCurrent(requestClient, sessionId, requestWorkspace, generation)) reportError(error);
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
    if (anyPromptRunning || operationRunning || tasksSaving || taskActionId) return;
    closeProjectSelector();
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

  async function selectWorkspace(selected: string): Promise<void> {
    if (anyPromptRunning || operationRunning || tasksSaving || taskActionId) return;
    closeProjectSelector();
    closeSessionSelector();
    if (!isAbsoluteProjectPath(selected)) {
      errorMessage = "The selected project path is not absolute.";
      return;
    }
    if (selected === workspace) {
      rememberProject(selected);
      return;
    }

    operationRunning = true;
    errorMessage = null;
    sessionRefreshGeneration += 1;
    try {
      await closeWorkspaceSessions();
      workspace = selected;
      sessions = [];
      taskLoadGeneration += 1;
      taskDocument = EMPTY_TASK_DOCUMENT;
      todoSnapshots = new Map();
      subagentSnapshots = new Map();
      registrySnapshots = new Map();
      registryActionId = null;
      slashCommandsBySession = new Map();
      taskActionId = null;
      taskLoadFailed = false;
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
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, selected);
      } catch {
        // A storage failure should not prevent opening a project for this run.
      }
      await Promise.all([openWorkspaceSession(), loadProjectTasks(selected)]);
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
  }

  function restoreProjects(): void {
    try {
      const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      const validSaved = saved && isAbsoluteProjectPath(saved) ? saved : undefined;
      workspace = validSaved ?? "";
      recentProjects = parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY), validSaved);
      savedActiveSessionIds = parseActiveSessionIds(localStorage.getItem(ACTIVE_SESSIONS_STORAGE_KEY));
    } catch {
      workspace = "";
      recentProjects = [];
      savedActiveSessionIds = new Map();
    }
  }

  async function loadProjectTasks(projectPath: string): Promise<void> {
    const generation = ++taskLoadGeneration;
    tasksLoading = true;
    taskLoadFailed = false;
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
    try {
      await invoke("write_project_tasks", { workspace: requestWorkspace, document: validated });
      return workspace === requestWorkspace;
    } catch (error) {
      if (workspace === requestWorkspace) taskDocument = previous;
      reportError(error);
      return false;
    } finally {
      tasksSaving = false;
    }
  }

  function createProjectTask(draft: ProjectTaskDraft): void {
    const title = draft.title.trim();
    if (!title) return;
    const timestamp = new Date().toISOString();
    const description = draft.description?.trim();
    const task: ProjectTask = {
      id: typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
    if (!title) return;
    const description = draft.description?.trim();
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

  function toggleProjectSelector(): void {
    if (projectSelectorOpen) {
      closeProjectSelector();
      return;
    }
    closeSessionSelector();
    projectSelectorOpen = true;
  }

  function closeProjectSelector(): void {
    projectSelectorOpen = false;
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
        restoredSessionTabs = restoredTabSessionIds(response);
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
      restoredSessionTabs = restoredTabSessionIds(response);

      const desktopSessionId = savedActiveSessionIds.get(requestWorkspace) ?? null;
      const sessionId = startupSessionId(response, desktopSessionId);
      if (desktopSessionId && desktopSessionId !== sessionId) forgetActiveSession(requestWorkspace);

      transcript = emptyTranscript;
      configOptions = [];
      activeSessionRuntimeReady = false;
      if (sessionId) {
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

      const created = await requestClient.newSession(requestWorkspace);
      if (client !== requestClient || workspace !== requestWorkspace) return;
      ensureProvisionalSession(created.sessionId, requestWorkspace);
      showSessionTab(created.sessionId);
      activeSessionId = created.sessionId;
      transcript = emptyTranscript;
      transcriptBySessionId.set(created.sessionId, transcript);
      configOptions = [];
      activeSessionRuntimeReady = false;
      rememberActiveSession(requestWorkspace, created.sessionId);
      void ensureSessionRuntime(requestClient, created.sessionId, requestWorkspace).then(() => {
        if (runtimeReadySessionIds.has(created.sessionId)) void refreshSessions();
      });
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

  async function createSession(): Promise<void> {
    if (!client || !canUseSession) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    errorMessage = null;
    try {
      const response = await requestClient.newSession(requestWorkspace);
      if (requestClient !== client || requestWorkspace !== workspace) return;
      if (activeSessionId) transcriptBySessionId.set(activeSessionId, transcript);
      ensureProvisionalSession(response.sessionId, requestWorkspace);
      showSessionTab(response.sessionId);
      activeSessionId = response.sessionId;
      rememberActiveSession(requestWorkspace, response.sessionId);
      transcript = emptyTranscript;
      transcriptBySessionId.set(response.sessionId, transcript);
      configOptions = [];
      activeSessionRuntimeReady = false;
      void ensureSessionRuntime(requestClient, response.sessionId, requestWorkspace).then(() => {
        if (runtimeReadySessionIds.has(response.sessionId)) void refreshSessions();
      });
    } catch (error) {
      reportError(error);
    } finally {
      operationRunning = false;
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

      const prompt = buildTaskPrompt(task);
      operationRunning = false;
      transcript = appendLocalUserMessage(transcript, prompt, `local:${++localMessageId}`, []);
      transcriptBySessionId.set(response.sessionId, transcript);
      await scrollToLatest();
      await runPromptRequest(requestClient, response.sessionId, [{ type: "text", text: prompt }]);
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
    if (!task.sessionId || taskActionId || operationRunning) return;
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

  async function closeWorkspaceSessions(): Promise<void> {
    sessionPrewarmGeneration += 1;
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
    configOptionsBySessionId.clear();
  }

  async function closeSessionTab(event: MouseEvent, sessionId: string): Promise<void> {
    event.stopPropagation();
    closeSessionSelector();
    sessionPrewarmGeneration += 1;
    if (sessionId !== activeSessionId) {
      if (runningSessionIds.has(sessionId) || operationRunning) return;
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
      } finally {
        operationRunning = false;
      }
      return;
    }
    if (runningSessionIds.has(sessionId) || operationRunning) return;

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
    if (!closed) return;
    if (nextSessionId) await loadSession(nextSessionId);
    else await createSession();
  }

  function showSessionTab(sessionId: string): void {
    closedSessionTabs = closedSessionTabs.filter((closedId) => closedId !== sessionId);
    if (restoredSessionTabs?.includes(sessionId) || locallyOpenedSessionTabs.includes(sessionId)) return;
    locallyOpenedSessionTabs = [...locallyOpenedSessionTabs, sessionId];
  }

  function ensureProvisionalSession(sessionId: string, cwd: string): void {
    if (sessions.some((session) => session.sessionId === sessionId)) return;
    sessions = [{ sessionId, cwd, updatedAt: new Date().toISOString() }, ...sessions];
  }

  function handleSessionTabClick(event: MouseEvent, sessionId: string): void {
    closeProjectSelector();
    if (sessionId !== activeSessionId) {
      closeSessionSelector();
      void loadSession(sessionId);
      return;
    }

    event.stopPropagation();
    if (sessionSelectorOpen) {
      closeSessionSelector();
    } else {
      sessionSelectorTrigger = event.currentTarget as HTMLButtonElement;
      openSessionSelector();
    }
  }

  function handleSessionPickerClick(event: MouseEvent): void {
    closeProjectSelector();
    if (sessionSelectorOpen) {
      closeSessionSelector();
      return;
    }
    sessionSelectorTrigger = event.currentTarget as HTMLButtonElement;
    openSessionSelector();
  }

  function openSessionSelector(query = "", mode: "open" | "delete" = "open"): void {
    if (!workspace || status !== "ready") return;
    sessionSelectorQuery = query;
    sessionSelectorMode = mode;
    sessionSelectorOpen = true;
    void refreshSessions();
  }

  function closeSessionSelector(restoreFocus = false): void {
    sessionSelectorOpen = false;
    sessionSelectorQuery = "";
    sessionSelectorMode = "open";
    if (restoreFocus) sessionSelectorTrigger?.focus();
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeSessionId) {
      closeSessionSelector();
      return;
    }
    void loadSession(sessionId);
  }

  async function deleteSelectedSession(sessionId: string): Promise<void> {
    const requestClient = client;
    if (!requestClient || operationRunning || runningSessionIds.has(sessionId)) return;
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
    else await createSession();
  }

  function activeCustomQuestionId(): string | null {
    const pending = pendingElicitation;
    if (!pending || pending.kind !== "question") return null;
    const question = pending.questions[pending.state.activeTab];
    if (!question || !pending.state.drafts[question.id]?.customSelected) return null;
    return question.id;
  }

  function canAcceptDroppedAttachments(): boolean {
    if (addingQuestionImages) return false;
    if (pendingElicitation?.kind === "question") return activeCustomQuestionId() !== null;
    return !!activeSessionId && !operationRunning;
  }

  function questionCanAcceptImages(questionId: string, requestId?: number): boolean {
    const pending = pendingElicitation;
    return !!pending
      && pending.kind === "question"
      && (requestId === undefined || pending.requestId === requestId)
      && pending.questions.some((question) => question.id === questionId)
      && pending.state.drafts[questionId]?.customSelected === true;
  }

  function questionImageRequestId(questionId: string): number | null {
    const pending = pendingElicitation;
    return pending?.kind === "question" && questionCanAcceptImages(questionId)
      ? pending.requestId
      : null;
  }

  function beginQuestionImageOperation(): number | null {
    if (activeQuestionImageOperationId !== null) return null;
    const operationId = ++questionImageOperationSequence;
    activeQuestionImageOperationId = operationId;
    addingQuestionImages = true;
    return operationId;
  }

  function finishQuestionImageOperation(operationId: number): void {
    if (activeQuestionImageOperationId !== operationId) return;
    activeQuestionImageOperationId = null;
    addingQuestionImages = false;
  }

  function cancelQuestionImageOperation(): void {
    activeQuestionImageOperationId = null;
    addingQuestionImages = false;
  }

  async function chooseQuestionImages(questionId: string, expectedRequestId?: number): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId)) return;
    const operationId = beginQuestionImageOperation();
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
      if (questionCanAcceptImages(questionId, requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(operationId);
    }
  }

  async function addQuestionImagePaths(questionId: string, paths: readonly string[]): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || paths.length === 0) return;
    const operationId = beginQuestionImageOperation();
    if (operationId === null) return;
    try {
      await appendQuestionImagePaths(questionId, requestId, paths);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(operationId);
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
    if (issue) errorMessage = issue;
  }

  async function addPastedQuestionImages(
    questionId: string,
    files: readonly File[],
    expectedRequestId?: number,
  ): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId) || files.length === 0) return;
    const operationId = beginQuestionImageOperation();
    if (operationId === null) return;
    try {
      const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
        name: file.name,
        size: file.size,
        mimeType: file.type || mimeTypeForName(file.name),
        readData: () => fileBase64(file),
      })));
      if (issue) errorMessage = issue;
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId)) reportError(error);
    } finally {
      finishQuestionImageOperation(operationId);
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
      const pending = pendingElicitation;
      if (!pending || pending.kind !== "question" || !questionCanAcceptImages(questionId, requestId)) return null;
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
      if (!questionCanAcceptImages(questionId, requestId)) return null;
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
    const pending = pendingElicitation;
    if (
      !pending
      || pending.kind !== "question"
      || !questionCanAcceptImages(questionId, requestId)
      || images.length === 0
    ) return;
    const question = pending.questions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    updateQuestionnaire(addQuestionImages(pending.state, questionId, images, question), requestId);
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

  async function chooseAttachments(): Promise<void> {
    if (!activeSessionId || operationRunning) return;
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

  function addAttachmentPaths(paths: readonly string[]): Promise<void> {
    const key = attachmentDraftKey;
    const generation = attachmentDraftGeneration;
    const operation = attachmentAddQueue.then(() => addAttachmentPathsNow(paths, key, generation));
    attachmentAddQueue = operation.catch(() => {});
    return operation;
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
    const operation = attachmentAddQueue.then(() => addPastedAttachmentsNow(files, key, generation));
    attachmentAddQueue = operation.catch(() => {});
    return operation;
  }

  async function addPastedAttachmentsNow(
    files: readonly File[],
    key: string,
    generation: number,
  ): Promise<void> {
    if (!attachmentDraftIsCurrent(key, generation)) return;
    if (!activeSessionId || operationRunning || files.length === 0) return;
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
      && !!activeSessionId
      && !operationRunning;
  }

  function invalidateAttachmentDraft(): void {
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
    projectFilePreviewGeneration += 1;
    previewHistory = emptyPreviewHistory();
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

  async function openProjectFile(path: string, navigation: PreviewNavigation = "replace"): Promise<void> {
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
      showPreview({ kind: "file", file: preview }, navigation);
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

  async function submitPrompt(): Promise<void> {
    const text = promptText.trim();
    const attachments = promptAttachments;
    const sessionId = activeSessionId;
    const draftKey = attachmentDraftKey;
    const draftGeneration = attachmentDraftGeneration;
    if (
      !client
      || !sessionId
      || !activeSessionRuntimeReady
      || (!text && attachments.length === 0)
      || operationRunning
      || sessionHistoryLoading
    ) return;
    const desktopCommand = parseDesktopSlashCommand(text, attachments.length > 0);
    if (desktopCommand) {
      switch (desktopCommand.kind) {
        case "new":
        case "new_tab":
          if (promptRunning) return;
          promptText = "";
          await createSession();
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
      transcript = appendLocalUserMessage(transcript, text, `local:${++localMessageId}`, attachments);
      transcriptBySessionId.set(sessionId, transcript);
      await scrollToLatest();
      await runPromptRequest(client, sessionId, blocks, fileImages);
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
      appendQueuedMessageToTranscript(sessionId, result.message);
      await runPromptRequest(requestClient, sessionId, queuedMessageBlocks(result.message));
      void refreshSessions();
    } catch (error) {
      if (requestClient === client && sessionId === activeSessionId) reportError(error);
    } finally {
      queueActionRunning = false;
    }
  }

  async function selectCommandOption(value: string): Promise<void> {
    const picker = commandPicker;
    if (!picker) return;
    commandPicker = null;
    if (picker.command === "history") {
      promptText = value;
      return;
    }
    if (picker.command === "jump") {
      await jumpToUserMessage(value);
      return;
    }
    promptText = `/${picker.command} ${value}`;
    await submitPrompt();
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
      commandPicker = listCommandPickerState("jump", items.reverse(), query);
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
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      transcript = appendLocalUserMessage(transcript, "/reload", `local:${++localMessageId}`);
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

  async function forkConversation(requestedEntryId?: string): Promise<void> {
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

      await requestClient.closeSession(sourceSessionId);
      sourceClosed = true;
      forgetSessionRuntime(sourceSessionId);
      clearSessionActivity(sourceSessionId);
      clearSessionActivity(forked.sessionId);
      activeSessionId = forked.sessionId;
      transcript = emptyTranscript;
      configOptions = forked.configOptions;
      markSessionRuntimeReady(forked.sessionId, forked.configOptions);

      const historyGeneration = beginSessionHistoryLoad();
      void hydrateSessionHistory(requestClient, forked.sessionId, requestWorkspace, historyGeneration);
      closedSessionTabs = [...new Set([...closedSessionTabs, sourceSessionId])];
      locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((id) => id !== sourceSessionId);
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

  async function setConfig(option: SessionConfigOption, value: string | boolean): Promise<void> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || !activeSessionRuntimeReady || changingConfig) return;
    changingConfig = option.id;
    try {
      const options = (await requestClient.setConfigOption(sessionId, option, value)).configOptions;
      configOptionsBySessionId.set(sessionId, options);
      if (requestClient === client && sessionId === activeSessionId) configOptions = options;
    } catch (error) {
      reportError(error);
    } finally {
      changingConfig = null;
    }
  }

  function requestElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const question = parseQuestionElicitation(request);
    const field = parseElicitation(request);
    if ((!question && !field) || pendingElicitation) return Promise.resolve({ action: "cancel" });
    return new Promise((resolve) => {
      pendingElicitation = question
        ? {
            kind: "question",
            requestId: ++elicitationSequence,
            message: question.message,
            questions: question.questions,
            state: createQuestionnaireState(question.questions),
            resolve,
          }
        : { kind: "form", message: request.message, field: field!, resolve };
    });
  }

  function updateQuestionnaire(state: QuestionnaireState, requestId?: number): void {
    if (
      !pendingElicitation
      || pendingElicitation.kind !== "question"
      || (requestId !== undefined && pendingElicitation.requestId !== requestId)
    ) return;
    pendingElicitation = { ...pendingElicitation, state };
  }

  function updateElicitationValue(value: string | boolean): void {
    if (!pendingElicitation || pendingElicitation.kind !== "form") return;
    pendingElicitation = {
      ...pendingElicitation,
      field: { ...pendingElicitation.field, value },
    };
  }

  function answerElicitation(accepted: boolean): void {
    const pending = pendingElicitation;
    if (!pending || pending.kind !== "form") return;
    pendingElicitation = null;
    pending.resolve(accepted
      ? { action: "accept", content: { [pending.field.key]: pending.field.value } }
      : { action: "cancel" });
  }

  function answerQuestion(state: QuestionnaireState, requestId: number): void {
    const pending = pendingElicitation;
    if (!pending || pending.kind !== "question" || pending.requestId !== requestId) return;
    const selections = createQuestionSelections(state, pending.questions);
    if (!selections) return;
    pendingElicitation = null;
    cancelQuestionImageOperation();
    pending.resolve(createQuestionAcceptResponse(selections));
  }

  function cancelElicitation(requestId: number): void {
    const pending = pendingElicitation;
    if (!pending || pending.kind !== "question" || pending.requestId !== requestId) return;
    pendingElicitation = null;
    cancelQuestionImageOperation();
    pending.resolve({ action: "cancel" });
  }

  function reportError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  async function scrollToLatest(): Promise<void> {
    await tick();
    transcriptPane?.scrollTo({ top: transcriptPane.scrollHeight, behavior: "smooth" });
  }

</script>

<svelte:head><title>Pix Desktop</title></svelte:head>

<div class="grid h-full grid-rows-[36px_minmax(0,1fr)_36px] bg-background text-foreground max-[760px]:grid-rows-[36px_minmax(0,1fr)_32px]">
  <header
    class="flex min-w-0 select-none items-stretch border-b border-sidebar-border bg-sidebar"
    data-tauri-drag-region
  >
    <ProjectTitlebar
      {workspace}
      {recentProjects}
      open={projectSelectorOpen}
      disabled={anyPromptRunning || operationRunning || tasksSaving || taskActionId !== null}
      onToggle={toggleProjectSelector}
      onSelectProject={(path) => void selectWorkspace(path)}
      onChooseWorkspace={() => void chooseWorkspace()}
      onClose={closeProjectSelector}
    />

    <div class="relative flex min-w-0 flex-1" data-tauri-drag-region>
      <SessionTabs
        sessions={tabSessions}
        allSessionsCount={sessions.length}
        {activeSessionId}
        {runningSessionIds}
        selectorOpen={sessionSelectorOpen}
        disabled={operationRunning}
        canCreate={canUseSession}
        onTabClick={handleSessionTabClick}
        onPickerClick={handleSessionPickerClick}
        onCloseTab={(event, sessionId) => void closeSessionTab(event, sessionId)}
        onCreate={() => void createSession()}
      />

      {#if sessionSelectorOpen}
        <SessionSelector
          {sessions}
          {activeSessionId}
          {activeTitle}
          initialQuery={sessionSelectorQuery}
          mode={sessionSelectorMode}
          canCreate={sessionSelectorMode === "open" && canUseSession}
          disabled={operationRunning}
          onCreate={() => void createSession()}
          onSelect={sessionSelectorMode === "delete" ? (sessionId) => void deleteSelectedSession(sessionId) : selectSession}
          onClose={closeSessionSelector}
        />
      {/if}
    </div>
  </header>

  <div class="flex min-h-0 min-w-0">
    <WorkspaceSidebar
      {workspace}
      tasks={taskDocument.tasks}
      loading={tasksLoading}
      saving={tasksSaving}
      storageError={taskLoadFailed}
      activeTaskId={taskActionId}
      sessionReady={canUseSession}
      {activeSessionId}
      todoSnapshot={activeTodoSnapshot}
      subagentSnapshot={activeSubagentSnapshot}
      registrySnapshot={activeRegistrySnapshot}
      {registryLoading}
      {registryActionId}
      onCreate={createProjectTask}
      onUpdate={updateProjectTask}
      onStatusChange={updateProjectTaskStatus}
      onDelete={deleteProjectTask}
      onReorder={reorderProjectTask}
      onRun={(task) => void runProjectTask(task)}
      onOpenSession={(task) => void openProjectTaskSession(task)}
      onReload={() => void loadProjectTasks(workspace)}
      onRegistryRefresh={refreshRegistry}
      onRegistryAction={(request, actionId) => void runRegistryAction(request, actionId)}
    />

    <main class="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
      {#if errorMessage}
        <ErrorBanner
          message={errorMessage}
          canReconnect={status === "error"}
          onReconnect={() => void reconnect()}
          onDismiss={() => errorMessage = null}
        />
      {/if}

      <TranscriptPane
        {transcript}
        {activeSessionId}
        {workspace}
        {promptRunning}
        {operationRunning}
        historyLoading={sessionHistoryLoading}
        bind:pane={transcriptPane}
        onChooseWorkspace={() => void chooseWorkspace()}
        onOpenAttachment={(attachment) => void activateAttachment(attachment)}
        onPrepareAttachment={prepareTranscriptAttachment}
        onOpenProjectFile={openProjectFile}
        onResolveProjectMedia={resolveProjectMedia}
        onOpenLocalFile={openLocalFile}
        onResolveLocalMedia={resolveLocalMedia}
        onLoadToolResult={(toolCallId) => void loadDeferredToolResult(toolCallId)}
      />

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
          ready={status === "ready" && activeSessionRuntimeReady && !operationRunning && !sessionHistoryLoading}
          {promptRunning}
          {dragActive}
          {autocompleteEnabled}
          {autocompleteDebounceMs}
          {questionMode}
          onAutocomplete={autocompletePrompt}
          onSubmit={submitPrompt}
          onDefer={deferCurrentDraft}
          onCancel={cancelPrompt}
          onChooseAttachments={chooseAttachments}
          onPasteAttachments={addPastedAttachments}
          onRemoveAttachment={removeAttachment}
          onOpenAttachment={(attachment) => void activateAttachment(attachment)}
        />
      </div>
    </main>
  </div>

  <StatusBar
    {status}
    {configOptions}
    {changingConfig}
    {promptRunning}
    canRefresh={canUseSession}
    onSetConfig={(option, value) => void setConfig(option, value)}
    onRefresh={() => void refreshSessions()}
  />
</div>

{#if pendingElicitation?.kind === "form"}
  <ElicitationDialog
    message={pendingElicitation.message}
    field={pendingElicitation.field}
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

{#if activePreview}
  <PreviewDialog
    previewId={activePreview.id}
    scrollPosition={activePreview.scrollPosition}
    file={activePreview.kind === "file" ? activePreview.file : undefined}
    attachment={activePreview.kind === "attachment" ? activePreview.attachment : undefined}
    canGoBack={canGoBackInPreview}
    canGoForward={canGoForwardInPreview}
    onBack={() => movePreview(-1)}
    onForward={() => movePreview(1)}
    onOpenProjectFile={(path) => openProjectFile(path, "push")}
    onResolveProjectMedia={resolveProjectMedia}
    onOpenLocalFile={(path) => openLocalFile(path, "push")}
    onResolveLocalMedia={resolveLocalMedia}
    onScrollPositionChange={rememberPreviewScroll}
    onClose={closePreview}
  />
{/if}
