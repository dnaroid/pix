<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open } from "@tauri-apps/plugin-dialog";
  import type {
    ContentBlock,
    CreateElicitationRequest,
    CreateElicitationResponse,
    SessionConfigOption,
    SessionInfo,
    SessionNotification,
  } from "@agentclientprotocol/sdk";
  import { AcpClient } from "./lib/acp-client";
  import { TauriAcpTransport } from "./lib/tauri-transport";
  import {
    appendLocalUserMessage,
    applySessionUpdate,
    emptyTranscript,
    type TranscriptState,
  } from "./lib/transcript";
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
    MAX_ATTACHMENTS,
    MAX_EMBEDDED_ATTACHMENT_BYTES,
    MAX_EMBEDDED_PROMPT_BYTES,
    attachmentFromFile,
    attachmentKind,
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
  import StatusBar from "./components/StatusBar.svelte";
  import ElicitationDialog from "./components/ElicitationDialog.svelte";
  import PreviewDialog from "./components/PreviewDialog.svelte";
  import ProjectTaskSidebar from "./components/ProjectTaskSidebar.svelte";
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
    parseTaskDocument,
    type ProjectTask,
    type ProjectTaskDocument,
    type ProjectTaskPriority,
    type ProjectTaskStatus,
    type ProjectTaskType,
  } from "./lib/project-tasks";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type PendingElicitation = {
    message: string;
    field: ElicitationField;
    resolve: (response: CreateElicitationResponse) => void;
  };
  type ProjectTaskDraft = {
    title: string;
    description?: string;
    type: ProjectTaskType;
    status: ProjectTaskStatus;
    priority: ProjectTaskPriority;
  };
  type PreviewTarget =
    | { kind: "file"; file: ProjectFilePreview }
    | { kind: "attachment"; attachment: Attachment };
  type PreviewEntry = PreviewTarget & {
    id: number;
    scrollPosition: PreviewScrollPosition;
  };
  type PreviewNavigation = "replace" | "push";

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
  let promptRunning = $state(false);
  let operationRunning = $state(false);
  let changingConfig = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let diagnostics = $state<string[]>([]);
  let pendingElicitation = $state<PendingElicitation | null>(null);
  let projectSelectorOpen = $state(false);
  let sessionSelectorOpen = $state(false);
  let sessionSelectorTrigger = $state<HTMLButtonElement | null>(null);
  let dragActive = $state(false);
  let previewHistory = $state<PreviewHistory<PreviewEntry>>(emptyPreviewHistory());
  let taskDocument = $state<ProjectTaskDocument>(EMPTY_TASK_DOCUMENT);
  let tasksLoading = $state(false);
  let tasksSaving = $state(false);
  let taskLoadFailed = $state(false);
  let taskActionId = $state<string | null>(null);
  let imagePromptSupported = false;
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let localMessageId = 0;
  let reconnectPromise: Promise<void> | null = null;
  let sessionRefreshGeneration = 0;
  let autocompleteSettingsGeneration = 0;
  let attachmentSequence = 0;
  let previewSequence = 0;
  let attachmentDraftGeneration = 0;
  let attachmentAddQueue = Promise.resolve();
  let sessionUpdateQueue = Promise.resolve();
  let previousAttachmentDraftKey: string | null = null;
  let projectFilePreviewGeneration = 0;
  let taskLoadGeneration = 0;
  const registeredAttachmentPaths = new Set<string>();

  const canUseSession = $derived(status === "ready" && !!workspace && !operationRunning);
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
    const sessionReady = status === "ready" && !operationRunning;
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
        dragActive = !!activeSessionId && !promptRunning && !operationRunning;
      } else if (payload.type === "leave") {
        dragActive = false;
      } else if (payload.type === "drop") {
        dragActive = false;
        if (activeSessionId && !promptRunning && !operationRunning) {
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
      pendingElicitation?.resolve({ action: "cancel" });
      pendingElicitation = null;
      void client?.dispose();
    };
  });

  async function connect(): Promise<void> {
    status = "starting";
    errorMessage = null;
    const next = new AcpClient(new TauriAcpTransport(), {
      onSessionUpdate: handleSessionUpdate,
      onElicitation: requestElicitation,
      onDiagnostic: (line) => {
        diagnostics = [...diagnostics.slice(-49), line];
      },
      onExit: (exit) => {
        if (client !== next) return;
        closeProjectSelector();
        closeSessionSelector();
        pendingElicitation?.resolve({ action: "cancel" });
        pendingElicitation = null;
        activeSessionId = null;
        transcript = emptyTranscript;
        configOptions = [];
        status = exit.requested ? "stopped" : "error";
        if (!exit.requested) {
          errorMessage = exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`;
        }
        promptRunning = false;
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
    pendingElicitation?.resolve({ action: "cancel" });
    pendingElicitation = null;
    activeSessionId = null;
    transcript = emptyTranscript;
    configOptions = [];
    promptRunning = false;
    operationRunning = false;
    changingConfig = null;
    await previous?.dispose().catch(() => {});
    await connect();
  }

  function handleSessionUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== activeSessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      configOptions = update.configOptions;
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
    sessionUpdateQueue = sessionUpdateQueue.then(async () => {
      if (notification.sessionId !== activeSessionId) return;
      const nextTranscript = applySessionUpdate(transcript, update);
      await registerTranscriptAttachments(nextTranscript);
      if (notification.sessionId !== activeSessionId) return;
      transcript = nextTranscript;
      void scrollToLatest();
    });
  }

  async function registerTranscriptAttachments(nextTranscript: TranscriptState): Promise<void> {
    const paths = nextTranscript.items
      .flatMap((item) => item.attachments)
      .flatMap((attachment) => attachment.path ? [attachment.path] : [])
      .filter((path) => !registeredAttachmentPaths.has(path));
    for (const path of paths) registeredAttachmentPaths.add(path);
    await Promise.all(paths.map((path) =>
      invoke<AttachmentFile[]>("inspect_attachments", { paths: [path] }).catch(() => []),
    ));
  }

  async function chooseWorkspace(): Promise<void> {
    if (promptRunning || operationRunning || tasksSaving || taskActionId) return;
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
    if (promptRunning || operationRunning || tasksSaving || taskActionId) return;
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
      await closeActiveSession();
      workspace = selected;
      sessions = [];
      taskLoadGeneration += 1;
      taskDocument = EMPTY_TASK_DOCUMENT;
      taskActionId = null;
      taskLoadFailed = false;
      restoredSessionTabs = null;
      locallyOpenedSessionTabs = [];
      closedSessionTabs = [];
      transcript = emptyTranscript;
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
      status: draft.status,
      priority: draft.priority,
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
            status: draft.status,
            priority: draft.priority,
            updatedAt: timestamp,
          }
        : task),
    });
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
    const generation = ++sessionRefreshGeneration;
    try {
      const response = await requestClient.listSessions(requestWorkspace);
      if (generation !== sessionRefreshGeneration || client !== requestClient || workspace !== requestWorkspace) return;
      sessions = response.sessions;
      restoredSessionTabs = restoredTabSessionIds(response);
    } catch (error) {
      if (generation !== sessionRefreshGeneration || client !== requestClient || workspace !== requestWorkspace) return;
      reportError(error);
    }
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
      if (sessionId) {
        activeSessionId = sessionId;
        const loaded = await requestClient.loadSession(sessionId, requestWorkspace);
        if (client !== requestClient || workspace !== requestWorkspace) return;
        configOptions = loaded.configOptions ?? [];
        showSessionTab(sessionId);
        rememberActiveSession(requestWorkspace, sessionId);
        await scrollToLatest();
        return;
      }

      const created = await requestClient.newSession(requestWorkspace);
      if (client !== requestClient || workspace !== requestWorkspace) return;
      showSessionTab(created.sessionId);
      activeSessionId = created.sessionId;
      configOptions = created.configOptions ?? [];
      rememberActiveSession(requestWorkspace, created.sessionId);
      await refreshSessions();
    } catch (error) {
      if (client !== requestClient || workspace !== requestWorkspace) return;
      activeSessionId = null;
      transcript = emptyTranscript;
      reportError(error);
    } finally {
      if (client === requestClient && workspace === requestWorkspace) operationRunning = false;
    }
  }

  async function createSession(): Promise<void> {
    if (!client || !canUseSession || promptRunning) return;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    errorMessage = null;
    try {
      await closeActiveSession();
      const response = await client.newSession(workspace);
      showSessionTab(response.sessionId);
      activeSessionId = response.sessionId;
      rememberActiveSession(workspace, response.sessionId);
      transcript = emptyTranscript;
      configOptions = response.configOptions ?? [];
      await refreshSessions();
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
    if (!client || !canUseSession || promptRunning || tasksSaving || taskActionId) return;
    const requestClient = client;
    const requestWorkspace = workspace;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    taskActionId = task.id;
    errorMessage = null;
    try {
      await closeActiveSession();
      if (client !== requestClient || workspace !== requestWorkspace) return;
      const response = await requestClient.newSession(requestWorkspace);
      if (client !== requestClient || workspace !== requestWorkspace) return;
      showSessionTab(response.sessionId);
      activeSessionId = response.sessionId;
      rememberActiveSession(requestWorkspace, response.sessionId);
      transcript = emptyTranscript;
      configOptions = response.configOptions ?? [];
      await refreshSessions();

      const timestamp = new Date().toISOString();
      const saved = await saveProjectTasks({
        ...taskDocument,
        tasks: taskDocument.tasks.map((candidate) => candidate.id === task.id
          ? {
              ...candidate,
              status: "in-progress",
              sessionId: response.sessionId,
              updatedAt: timestamp,
            }
          : candidate),
      });
      if (!saved || client !== requestClient || workspace !== requestWorkspace) return;

      const prompt = buildTaskPrompt(task);
      promptRunning = true;
      operationRunning = false;
      transcript = appendLocalUserMessage(transcript, prompt, `local:${++localMessageId}`, []);
      await scrollToLatest();
      await requestClient.prompt(response.sessionId, [{ type: "text", text: prompt }]);
      await refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      if (workspace === requestWorkspace) {
        promptRunning = false;
        operationRunning = false;
        taskActionId = null;
      }
    }
  }

  async function openProjectTaskSession(task: ProjectTask): Promise<void> {
    if (!task.sessionId || taskActionId || promptRunning || operationRunning) return;
    if (task.sessionId === activeSessionId) return;
    taskActionId = task.id;
    try {
      await loadSession(task.sessionId);
    } finally {
      taskActionId = null;
    }
  }

  async function loadSession(sessionId: string): Promise<void> {
    if (!client || !canUseSession || promptRunning || sessionId === activeSessionId) return;
    closeProjectSelector();
    closeSessionSelector();
    operationRunning = true;
    errorMessage = null;
    try {
      await closeActiveSession();
      closedSessionTabs = closedSessionTabs.filter((closedId) => closedId !== sessionId);
      activeSessionId = sessionId;
      transcript = emptyTranscript;
      configOptions = [];
      const response = await client.loadSession(sessionId, workspace);
      configOptions = response.configOptions ?? [];
      showSessionTab(sessionId);
      rememberActiveSession(workspace, sessionId);
      await scrollToLatest();
    } catch (error) {
      activeSessionId = null;
      transcript = emptyTranscript;
      reportError(error);
    } finally {
      operationRunning = false;
    }
  }

  async function closeActiveSession(): Promise<void> {
    const sessionId = activeSessionId;
    activeSessionId = null;
    if (!client || !sessionId) return;
    await client.closeSession(sessionId);
  }

  async function closeSessionTab(event: MouseEvent, sessionId: string): Promise<void> {
    event.stopPropagation();
    closeSessionSelector();
    if (sessionId !== activeSessionId) {
      closedSessionTabs = [...closedSessionTabs, sessionId];
      locallyOpenedSessionTabs = locallyOpenedSessionTabs.filter((openId) => openId !== sessionId);
      return;
    }
    if (promptRunning || operationRunning) return;

    const nextSessionId = tabSessions.find((session) => session.sessionId !== sessionId)?.sessionId;
    let closed = false;
    operationRunning = true;
    errorMessage = null;
    try {
      await client?.closeSession(sessionId);
      activeSessionId = null;
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

  function openSessionSelector(): void {
    if (!workspace || status !== "ready") return;
    sessionSelectorOpen = true;
    void refreshSessions();
  }

  function closeSessionSelector(restoreFocus = false): void {
    sessionSelectorOpen = false;
    if (restoreFocus) sessionSelectorTrigger?.focus();
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeSessionId) {
      closeSessionSelector();
      return;
    }
    void loadSession(sessionId);
  }

  async function chooseAttachments(): Promise<void> {
    if (!activeSessionId || promptRunning || operationRunning) return;
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
    if (!activeSessionId || promptRunning || operationRunning || files.length === 0) return;
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
        const data = await fileBase64(file);
        const cached = await invoke<AttachmentFile>("cache_attachment", { name: file.name, data });
        if (!attachmentDraftIsCurrent(key, generation)) return;
        const inferredMimeType = mimeTypeForName(file.name);
        const mimeType = file.type || inferredMimeType;
        const kind = attachmentKind(mimeType);
        const base = attachmentFromFile(cached, nextAttachmentId());
        attachments.push({
          ...base,
          kind,
          mimeType,
          ...(kind === "image" ? { dataUrl: `data:${mimeType};base64,${data}` } : {}),
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
      && !promptRunning
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
    if (attachment.path) {
      try {
        await invoke<AttachmentFile[]>("inspect_attachments", { paths: [attachment.path] });
      } catch (error) {
        reportError(error);
        return;
      }
    }
    if (attachment.kind === "image" || attachment.kind === "video") {
      showPreview({ kind: "attachment", attachment }, "replace");
      return;
    }
    if (!attachment.path) {
      errorMessage = `Cannot open ${attachment.name}: no local path is available.`;
      return;
    }
    try {
      await invoke("open_attachment", { path: attachment.path });
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

  async function buildPromptBlocks(text: string, attachments: readonly Attachment[]): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    let embeddedBytes = 0;
    if (text) blocks.push({ type: "text", text });
    for (const attachment of attachments) {
      if (attachment.kind === "image" && imagePromptSupported) {
        const data = await imageDataForPrompt(attachment);
        embeddedBytes += Math.floor(data.length * 3 / 4);
        if (embeddedBytes > MAX_EMBEDDED_PROMPT_BYTES) {
          throw new Error("Attached images exceed the 50 MB combined prompt limit.");
        }
        blocks.push({
          type: "image",
          data,
          mimeType: attachment.mimeType,
          ...(attachment.path ? { uri: fileUriFromPath(attachment.path) } : {}),
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
    return blocks;
  }

  async function imageDataForPrompt(attachment: Attachment): Promise<string> {
    if (attachment.dataUrl) return attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1);
    if (attachment.path) return invoke<string>("read_attachment_base64", { path: attachment.path });
    throw new Error(`Cannot read ${attachment.name}.`);
  }

  async function fileBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  async function submitPrompt(): Promise<void> {
    const text = promptText.trim();
    const attachments = promptAttachments;
    const sessionId = activeSessionId;
    const draftKey = attachmentDraftKey;
    const draftGeneration = attachmentDraftGeneration;
    if (!client || !sessionId || (!text && attachments.length === 0) || promptRunning) return;
    promptRunning = true;
    errorMessage = null;
    try {
      const blocks = await buildPromptBlocks(text, attachments);
      if (
        sessionId !== activeSessionId
        || draftKey !== attachmentDraftKey
        || draftGeneration !== attachmentDraftGeneration
        || attachments !== promptAttachments
      ) return;
      promptText = "";
      invalidateAttachmentDraft();
      transcript = appendLocalUserMessage(transcript, text, `local:${++localMessageId}`, attachments);
      await scrollToLatest();
      await client.prompt(sessionId, blocks);
      await refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      promptRunning = false;
    }
  }

  function autocompletePrompt(draft: string, signal: AbortSignal): Promise<string> {
    const requestClient = client;
    const sessionId = activeSessionId;
    if (!requestClient || !sessionId || status !== "ready") return Promise.resolve("");
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
    if (!client || !activeSessionId || changingConfig) return;
    changingConfig = option.id;
    try {
      configOptions = (await client.setConfigOption(activeSessionId, option, value)).configOptions;
    } catch (error) {
      reportError(error);
    } finally {
      changingConfig = null;
    }
  }

  function requestElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const field = parseElicitation(request);
    if (!field || pendingElicitation) return Promise.resolve({ action: "cancel" });
    return new Promise((resolve) => {
      pendingElicitation = { message: request.message, field, resolve };
    });
  }

  function updateElicitationValue(value: string | boolean): void {
    if (!pendingElicitation) return;
    pendingElicitation = {
      ...pendingElicitation,
      field: { ...pendingElicitation.field, value },
    };
  }

  function answerElicitation(accepted: boolean): void {
    const pending = pendingElicitation;
    if (!pending) return;
    pendingElicitation = null;
    pending.resolve(accepted
      ? { action: "accept", content: { [pending.field.key]: pending.field.value } }
      : { action: "cancel" });
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
      disabled={promptRunning || operationRunning || tasksSaving || taskActionId !== null}
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
        selectorOpen={sessionSelectorOpen}
        disabled={promptRunning || operationRunning}
        canCreate={canUseSession && !promptRunning}
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
          canCreate={canUseSession && !promptRunning}
          disabled={promptRunning || operationRunning}
          onCreate={() => void createSession()}
          onSelect={selectSession}
          onClose={closeSessionSelector}
        />
      {/if}
    </div>
  </header>

  <div class="flex min-h-0 min-w-0">
    <ProjectTaskSidebar
      {workspace}
      tasks={taskDocument.tasks}
      loading={tasksLoading}
      saving={tasksSaving}
      storageError={taskLoadFailed}
      activeTaskId={taskActionId}
      sessionReady={canUseSession && !promptRunning}
      onCreate={createProjectTask}
      onUpdate={updateProjectTask}
      onDelete={deleteProjectTask}
      onRun={(task) => void runProjectTask(task)}
      onOpenSession={(task) => void openProjectTaskSession(task)}
      onReload={() => void loadProjectTasks(workspace)}
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
        bind:pane={transcriptPane}
        onChooseWorkspace={() => void chooseWorkspace()}
        onOpenAttachment={(attachment) => void activateAttachment(attachment)}
        onOpenProjectFile={openProjectFile}
        onResolveProjectMedia={resolveProjectMedia}
        onOpenLocalFile={openLocalFile}
        onResolveLocalMedia={resolveLocalMedia}
      />

      <PromptComposer
        bind:promptText
        attachments={promptAttachments}
        {activeSessionId}
        ready={status === "ready"}
        {promptRunning}
        {dragActive}
        {autocompleteEnabled}
        {autocompleteDebounceMs}
        onAutocomplete={autocompletePrompt}
        onSubmit={submitPrompt}
        onCancel={cancelPrompt}
        onChooseAttachments={chooseAttachments}
        onPasteAttachments={addPastedAttachments}
        onRemoveAttachment={removeAttachment}
        onOpenAttachment={(attachment) => void activateAttachment(attachment)}
      />
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

{#if pendingElicitation}
  <ElicitationDialog
    message={pendingElicitation.message}
    field={pendingElicitation.field}
    onValueChange={updateElicitationValue}
    onAnswer={answerElicitation}
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
