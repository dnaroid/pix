<script lang="ts">
  import { onMount, tick } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import type {
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

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type PendingElicitation = {
    message: string;
    field: ElicitationField;
    resolve: (response: CreateElicitationResponse) => void;
  };

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
  let promptRunning = $state(false);
  let operationRunning = $state(false);
  let changingConfig = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let diagnostics = $state<string[]>([]);
  let pendingElicitation = $state<PendingElicitation | null>(null);
  let projectSelectorOpen = $state(false);
  let sessionSelectorOpen = $state(false);
  let sessionSelectorTrigger = $state<HTMLButtonElement | null>(null);
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let localMessageId = 0;
  let reconnectPromise: Promise<void> | null = null;
  let sessionRefreshGeneration = 0;

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

  onMount(() => {
    let disposed = false;
    restoreProjects();
    void connect().then(() => {
      if (disposed) void client?.dispose();
    });
    return () => {
      disposed = true;
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
      await next.start();
      if (client !== next) {
        await next.dispose();
        return;
      }
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
    transcript = applySessionUpdate(transcript, update);
    void scrollToLatest();
  }

  async function chooseWorkspace(): Promise<void> {
    if (promptRunning || operationRunning) return;
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
    if (promptRunning || operationRunning) return;
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
      await openWorkspaceSession();
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

  async function submitPrompt(): Promise<void> {
    const text = promptText.trim();
    if (!client || !activeSessionId || !text || promptRunning) return;
    promptText = "";
    promptRunning = true;
    errorMessage = null;
    transcript = appendLocalUserMessage(transcript, text, `local:${++localMessageId}`);
    await scrollToLatest();
    try {
      await client.prompt(activeSessionId, text);
      await refreshSessions();
    } catch (error) {
      reportError(error);
    } finally {
      promptRunning = false;
    }
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
      disabled={promptRunning || operationRunning}
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

  <main class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
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
    />

    <PromptComposer
      bind:promptText
      {activeSessionId}
      ready={status === "ready"}
      {promptRunning}
      onSubmit={submitPrompt}
      onCancel={cancelPrompt}
    />
  </main>

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
