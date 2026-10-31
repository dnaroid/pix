<script lang="ts">
  import { projectFolderHue } from "./lib/recent-projects";
  import { modelThinkingConfigState } from "./lib/model-thinking";
  import { createComposerMessageEdit } from "./app/composer-message-edit.svelte";
  import { onDestroy, onMount, setContext, tick, untrack } from "svelte";
  import { WIKI_CONSISTENCY_CONTEXT } from "./app/wiki-consistency-owner.svelte";
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import { createWindowRunActivitySync, hasRestartBlockingRun } from "./app/window-run-activity";
  import { installDesktopContextMenu } from "./lib/desktop-context-menu";
  import { createSelectionAssistStore } from "./app/selection-assist.svelte";
  import SelectionAssistPopover from "./components/SelectionAssistPopover.svelte";
  import { explainFileTarget } from "./lib/selection-assist-target";
  import { createSessionRename } from "./app/session-rename.svelte";
  import SessionRenameDialog from "./components/SessionRenameDialog.svelte";
  import type { DesktopShortcutPlatform } from "./lib/desktop-commands";
  import type { Attachment } from "./lib/attachments";
  import DesktopTitlebar from "./components/DesktopTitlebar.svelte";
  import UniversalSearch from "./components/UniversalSearch.svelte";
  import { createSearchNavigation } from "./app/search-navigation";
  import { SearchDialogMemory } from "./lib/search-dialog-memory";
  import { parseTaskDocument } from "./lib/project-tasks";
  import DesktopSidebar from "./components/DesktopSidebar.svelte";
  import DesktopWorkbenchSurface from "./components/DesktopWorkbenchSurface.svelte";
  import DesktopOverlays from "./components/DesktopOverlays.svelte";
  import DesktopStatusBar from "./components/DesktopStatusBar.svelte";
  import DesktopUpdateBanner from "./components/DesktopUpdateBanner.svelte";
  import ToastViewport from "./components/ToastViewport.svelte";
  import { toasts } from "./app/toasts.svelte";
  import DesktopBootstrapDialog from "./components/DesktopBootstrapDialog.svelte";
  import DeleteConfirmationHost from "./components/DeleteConfirmationHost.svelte";
  import ModelSetupDialog from "./components/ModelSetupDialog.svelte";
  import { workbenchSessionTabId, type WorkbenchTabId } from "./lib/workbench-tabs";
  import { createTranscriptAttachmentController } from "./app/transcript-attachments";
  import { createTranscriptScrollController } from "./app/transcript-scroll.svelte";
  import { createErrorState } from "./app/error-state.svelte";
  import { createDiagnosticLogger } from "./lib/diagnostic-logging";
  import { createActiveSessionState } from "./app/active-session-state.svelte";
  import { createDesktopSessionServices } from "./app/desktop-session-services";
  import { createDesktopProjectServices } from "./app/desktop-project-services";
  import { createDesktopConnectionServices } from "./app/desktop-connection-services";
  import { createBackgroundForkController } from "./app/background-fork";
  import { createDesktopSessionOrchestration } from "./app/desktop-session-orchestration";
  import { createDesktopLifecycleServices } from "./app/desktop-lifecycle-services";
  import { createDesktopPromptServices } from "./app/desktop-prompt-services";
  import { createDesktopWorkspaceServices } from "./app/desktop-workspace-services";
  import { createDesktopWorkspaceSessionStartup } from "./app/desktop-workspace-session-startup";
  import { createDesktopSessionTransitionServices } from "./app/desktop-session-transition-services";
  import { createDesktopProjectActionServices } from "./app/desktop-project-action-services";
  import { createDesktopPromptActionServices } from "./app/desktop-prompt-action-services";
  import { createDesktopConversationServices } from "./app/desktop-conversation-services";
  import { createDesktopWorkbenchGitServices } from "./app/desktop-workbench-git-services";
  import { createDesktopModelServices } from "./app/desktop-model-services";
  import { createDesktopCommandServices } from "./app/desktop-command-services";
  import { createDesktopInteractionServices } from "./app/desktop-interaction-services.svelte";
  import { createDesktopPresentationState } from "./app/desktop-presentation-state.svelte";
  import { createDesktopRootEffects } from "./app/desktop-root-effects.svelte";
  import { createSessionTabAttentionStore } from "./app/session-tab-attention.svelte";
  import { createDesktopTrayAttention } from "./lib/desktop-tray-attention";
  import { planLaunchOutcome } from "./lib/plan-launches";
  import { createDesktopViewModelServices } from "./app/desktop-view-model-services";
  import {
    createDesktopAgentNotificationCoordinator,
    desktopWindowForeground,
    createDesktopNotificationService,
  } from "./lib/desktop-notifications";
  import { resolveDesktopPreferences } from "./lib/desktop-config";
  import { createDesktopUpdater } from "./app/desktop-updater.svelte";
  import { createDesktopWatchRestart } from "./app/desktop-watch-restart.svelte";
  import { createLspOnboardingStore } from "./app/lsp-onboarding.svelte";
  import { createQuotaWaitStore } from "./app/quota-wait.svelte";
  import { createHeadsUpStore } from "./app/heads-up.svelte";
  import { createBackgroundJobsStore } from "./app/background-jobs.svelte";
  import { createBtwStore } from "./app/btw.svelte";
  import { btwDiscussionDraft, canInsertBtwDraft } from "./app/btw-draft";
  import BtwDock from "./components/BtwDock.svelte";
  import { startThemePreference } from "./lib/theme-preference";
  import { createWorkbenchTerminalState } from "./app/workbench-terminal.svelte";
  import {
    createWorkbenchWikiConflictsState,
    WIKI_CONFLICTS_NAVIGATION_CONTEXT,
    type WikiConflictsNavigation,
  } from "./app/workbench-wiki-conflicts.svelte";

  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const desktopShortcutPlatform: DesktopShortcutPlatform = isMacOS ? "mac" : "other";
  const desktopUpdaterEnabled = import.meta.env.VITE_PIX_DESKTOP_UPDATER === "1";

  let workspace = $state("");
  let searchOpen = $state(false);
  const searchMemory = new SearchDialogMemory();
  const activeSessionState = createActiveSessionState();
  const activeSessionId = $derived(activeSessionState.sessionId);
  const transcript = $derived(activeSessionState.transcript);
  const configOptions = $derived(activeSessionState.configOptions);
  let promptText = $state("");
  let promptAttachments = $state<Attachment[]>([]);
  let operationRunning = $state(false);
  const activeSessionRuntimeReady = $derived(activeSessionState.runtimeReady);
  let dragActive = $state(false);
  let activeWorkbenchTabId = $state<WorkbenchTabId | null>(null);
  let workbenchAuxSequence = 0;
  const workbenchTerminal = createWorkbenchTerminalState({
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    nextWorkbenchAuxOrder: () => ++workbenchAuxSequence,
  });
  const workbenchWikiConflicts = createWorkbenchWikiConflictsState({
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    nextWorkbenchAuxOrder: () => ++workbenchAuxSequence,
    // Read lazily after project services exist.
    snapshot: () => projectServices.wikiConsistency.wikiPath() ? projectServices.wikiConsistency.findings() : null,
    revealList: () => workspaceSidebar?.openWikiConflicts(),
  });
  let previewPane = $state<{ requestClose: () => Promise<boolean> } | null>(null);
  let workbenchTerminalPane = $state<{ openTerminal: (command: string) => Promise<void> } | null>(null);
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let transcriptContent = $state<HTMLDivElement | null>(null);
  let promptComposer = $state<{
    focus: () => Promise<void>;
    insertPaths: (paths: readonly string[]) => Promise<void>;
  } | null>(null);
  let workspaceSidebar = $state<{
    revealProjectEntry: (path: string) => Promise<void>;
    openTasksPanel: (taskId?: string, isCurrent?: () => boolean) => Promise<void>;
    openSettingsSection: (id: string) => Promise<void>;
    openSettingsField: (section: string, fieldId: string) => Promise<void>;
    openGitPanel: (isCurrent?: () => boolean) => void;
    openWikiChecks: () => Promise<void>;
    openWikiConflicts: () => Promise<void>;
    closeProjectSwitcher: () => void;
    openProjectSettings: () => void;
  } | null>(null);
  let localMessageId = 0;
  let onSessionActivityChanged = (_sessionId: string): void => {};

  const diagnosticLogger = createDiagnosticLogger(() => ({ workspace, sessionId: activeSessionId }));
  const errors = createErrorState(diagnosticLogger.report);
  const reportError = errors.report;
  const updater = createDesktopUpdater(undefined, diagnosticLogger.record);
  const desktopWatchRestart = createDesktopWatchRestart();

  const transcriptScroll = createTranscriptScrollController({
    activeSessionId: () => activeSessionId,
    pane: () => transcriptPane,
    content: () => transcriptContent,
    openSessionIds: () => tabSessions.map((session) => session.sessionId),
  });
  const transcriptFollowsLatest = $derived(transcriptScroll.followsLatest);
  const scheduleScrollToLatest = transcriptScroll.scheduleScrollToLatest;
  const scrollToLatest = transcriptScroll.scrollToLatest;
  const scrollToTranscriptEntry = transcriptScroll.scrollToEntry;

  const connection = createDesktopConnectionServices({
    onTaskRun: (request, signal) => projectActionServices.runTaskFromAgent(request, signal),
    workspace: () => workspace,
    onSessionCatalogChanged: (cwd) => sessionServices.catalog.nativeCatalogChanged(cwd),
    sessionCoordinator: () => sessionCoordinator,
    promptRuntime: () => promptRuntime,
    workspaceSessionStartup: () => workspaceSessionStartup,
    onForkReady: (notification) => { void backgroundFork.handleReady(notification); },
    requestElicitation: (request) => requestElicitation(request),
    setErrorMessage: errors.set,
    reportError,
    recordDiagnostic: diagnosticLogger.record,
  });
  const client = $derived(connection.client);
  const status = $derived(connection.status);
  const diagnostics = $derived(connection.diagnostics);
  const imagePromptSupported = $derived(connection.imagePromptSupported);
  const reconnect = connection.reconnect;

  const quotaWait = createQuotaWaitStore({
    client: () => client,
    runtimeReady: (sessionId) => sessionServices.runtime.isReady(sessionId),
    reportError,
  });
  const backgroundFork = createBackgroundForkController({
    client: () => client,
    workspace: () => workspace,
    get sessions() { return sessionServices; },
    reportError,
  });
  const sessionServices = createDesktopSessionServices({
    client: () => client,
    workspace: () => workspace,
    state: activeSessionState,
    statusReady: () => status === "ready",
    operationRunning: () => operationRunning,
    refreshQueueState: (sessionId) => promptRuntime.refreshQueueState(sessionId),
    scheduleScrollToLatest,
    recoverUnavailableSession: (requestClient, sessionId, requestWorkspace) => {
      errors.clear();
      sessionServices.tabs.forgetActive(requestWorkspace);
      sessionServices.catalog.remove(sessionId);
      sessionServices.tabs.remove(sessionId);
      activeSessionState.clearActiveSession();
      sessionCoordinator.forgetRuntime(sessionId);
      activateDraftSessionTab({ resetComposer: true });
      void requestClient.deleteSession(sessionId).catch(() => undefined);
    },
    onActivityChanged: (sessionId) => onSessionActivityChanged(sessionId),
    promptRunning: (sessionId) => promptRuntime.isRunning(sessionId),
    reportError,
  });
  const sessionActivity = sessionServices.activity;
  const headsUp = createHeadsUpStore({
    client: () => client,
    runtimeReady: (sessionId) => sessionServices.runtime.isReady(sessionId),
    commandAvailable: (sessionId) => sessionServices.metadata.slashCommandsBySession.get(sessionId)?.some((command) => command.name === "heads-up") ?? false,
    reportError,
  });

  const backgroundJobs = createBackgroundJobsStore({
    client: () => client,
    runtimeReady: (sessionId) => sessionServices.runtime.isReady(sessionId),
    reportError,
  });

  const btw = createBtwStore({
    command: (sessionId, command) => {
      if (!client) return Promise.reject(new Error("Desktop is disconnected"));
      return client.btw(sessionId, command);
    },
    runtimeReady: (sessionId) => sessionServices.runtime.isReady(sessionId),
  });
  let btwDock = $state<{ focus: () => void } | null>(null);

  async function openBtw(sessionId: string, question?: string): Promise<void> {
    await btw.open(sessionId);
    const snapshot = btw.state(sessionId);
    if (!snapshot) throw new Error("Could not open BTW. Update or reconnect the Desktop runtime.");
    if (question && snapshot.draft && snapshot.draft !== question) {
      throw new Error("BTW has an unsent draft. Send or clear it before using /btw with another question.");
    }
    if (activeSessionId === sessionId) {
      await tick();
      if (activeSessionId === sessionId) btwDock?.focus();
    }
    if (question) { btw.setDraft(sessionId, question); await btw.send(sessionId); }
  }

  function insertBtwAnswer(sessionId: string, text: string): boolean {
    if (!canInsertBtwDraft(sessionId, activeSessionId, activeSessionRuntimeReady,
      sessionMutationRunning || !!activePendingElicitation, promptText, promptAttachments)) return false;
    promptText = btwDiscussionDraft(text);
    void promptComposer?.focus();
    return true;
  }


  const sessionTabsState = sessionServices.tabs;
  const sessionSelectorOpen = $derived(sessionTabsState.selectorOpen);
  const sessionSelectorQuery = $derived(sessionTabsState.selectorQuery);
  const sessionSelectorMode = $derived(sessionTabsState.selectorMode);

  const sessionCatalog = sessionServices.catalog;
  const sessions = $derived(sessionCatalog.sessions);
  const sessionTabAttention = createSessionTabAttentionStore();
  const trayAttention = createDesktopTrayAttention({
    reportWarning: diagnosticLogger.warn,
    isSessionVisible: (sessionId) => desktopWindowForeground()
      && (sessionId === null || activeWorkbenchTabId === workbenchSessionTabId(sessionId)),
  });

  let pixSoundErrorReported = false;
  const desktopNotifications = createDesktopNotificationService({
    preferences: async () => {
      const notificationWorkspace = workspace;
      const [globalConfig, projectConfig] = await Promise.all([
        invoke<{ content: string }>("read_user_config", { kind: "desktop" }).catch(() => undefined),
        notificationWorkspace
          ? invoke<{ content: string }>("read_project_file", {
              workspace: notificationWorkspace,
              path: ".pi/pix-desktop.jsonc",
            }).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      return resolveDesktopPreferences(globalConfig?.content, projectConfig?.content);
    },
    isActiveSession: (sessionId) => sessionId !== null
      && activeWorkbenchTabId === workbenchSessionTabId(sessionId),
    reportWarning: diagnosticLogger.warn,
    playPixSound: async () => {
      if (!isTauri()) return;
      try {
        await invoke("desktop_play_notification_sound");
      } catch (error) {
        if (!pixSoundErrorReported) {
          pixSoundErrorReported = true;
          diagnosticLogger.warn("notification:sound", error);
        }
      }
    },
  });
  const agentNotifications = createDesktopAgentNotificationCoordinator({
    notifications: desktopNotifications,
    attention: trayAttention,
    sessionTitle: (sessionId) => sessionCatalog.sessions.find((session) => session.sessionId === sessionId)?.title ?? undefined,
    agentState: (sessionId) => promptRuntime.agentState(sessionId),
    isPromptRunning: (sessionId) => promptRuntime.isRunning(sessionId),
    activeSubagents: (sessionId) => sessionActivity.summaries.get(sessionId)?.activeSubagents ?? 0,
    onCompleted: (sessionId) => sessionTabAttention.markCompleted(
      sessionId,
      activeWorkbenchTabId === workbenchSessionTabId(sessionId),
    ),
  });
  onSessionActivityChanged = agentNotifications.sessionActivityChanged;

  const sessionRuntime = sessionServices.runtime;
  const changingConfig = $derived(
    activeSessionId ? sessionRuntime.changingConfig.get(activeSessionId) ?? null : null,
  );
  const refreshRuntimeStatus = sessionRuntime.refreshStatus;

  const sessionMetadata = sessionServices.metadata;
  const slashCommandsBySession = $derived(sessionMetadata.slashCommandsBySession);

  const sessionHistory = sessionServices.history;
  const sessionHistoryLoading = $derived(sessionHistory.loading);
  const loadDeferredToolResult = sessionHistory.loadDeferredToolResult;

  const autocomplete = sessionServices.autocomplete;

  const promptServices = createDesktopPromptServices({
    client: () => client,
    state: activeSessionState,
    sessionRuntime,
    operationRunning: () => operationRunning,
    sessionHistoryLoading: () => sessionHistoryLoading,
    followsLatest: () => transcriptFollowsLatest,
    scheduleScrollToLatest,
    nextAttachmentId: () => attachmentDrafts.nextAttachmentId(),
    bumpAttachmentGeneration: () => attachmentDrafts.bumpGeneration(),
    setPromptText: (text) => promptText = text,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
    setErrorMessage: errors.set,
    reportError,
    onPromptStarted: (sessionId) => {
      sessionTabAttention.clear(sessionId);
      agentNotifications.promptStarted(sessionId);
      projectServices.planLaunches.started(sessionId);
    },
    onPromptSettled: (sessionId, stopReason) => {
      agentNotifications.promptSettled(sessionId, stopReason);
      projectServices.planLaunches.settle(sessionId, planLaunchOutcome(stopReason));
    },
    onPromptError: (sessionId, error) => {
      agentNotifications.promptError(sessionId, error);
      projectServices.planLaunches.settle(sessionId, "failed");
    },
    onAgentPaused: agentNotifications.paused,
    onSessionCleared: (sessionId) => {
      sessionTabAttention.clear(sessionId);
      agentNotifications.clearSession(sessionId);
    },
    onReset: () => {
      sessionTabAttention.reset();
      agentNotifications.reset();
    },
    suppressAutoQueue: (sessionId) => quotaWait.waiting(sessionId),
  });
  const promptRuntime = promptServices.runtime;
  const queuedMessages = promptServices.queue;
  const queueItemsBySession = $derived(promptRuntime.queueItemsBySession);
  const refreshQueueState = promptRuntime.refreshQueueState;
  const lspOnboarding = createLspOnboardingStore({
    workspace: () => workspace,
    activeSessionId: () => activeSessionId,
    promptRunning: promptRuntime.isRunning,
    agentState: promptRuntime.agentState,
    pauseActiveAgent: promptRuntime.pauseActiveAgent,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    nextWorkbenchAuxOrder: () => ++workbenchAuxSequence,
  });

  const projectServices = createDesktopProjectServices({
    revealProjectEntry: async (path) => { await workspaceSidebar?.revealProjectEntry(path); },
    openKnowledgeChecks: () => workspaceSidebar?.openWikiChecks(),
    openWikiConflicts: (input) => workbenchWikiConflicts.show(input),
    knowledgeBackgroundReady: () => status === "ready" && Boolean(client),
    client: () => client,
    workspace: () => workspace,
    operationRunning: () => operationRunning,
    sessionWorkspace: (sessionId) => sessions.find((session) => session.sessionId === sessionId)?.cwd,
    transcript: () => transcript,
    prepareAttachment: (attachment) => transcriptAttachments.prepare(attachment),
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    activeConversationWorkbenchTabId: () => activeConversationWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    nextWorkbenchAuxOrder: () => ++workbenchAuxSequence,
    setErrorMessage: errors.set,
    clearError: errors.clear,
    reportError,
  });
  setContext(WIKI_CONSISTENCY_CONTEXT, projectServices.wikiConsistency);
  const projectTasks = projectServices.tasks;
  const tasksSaving = $derived(projectTasks.saving);

  const workspaceServices = createDesktopWorkspaceServices({
    workspace: () => workspace,
    setWorkspace: (selected) => workspace = selected,
    blocked: () => anyPromptRunning || sessionMutationRunning || tasksSaving || taskActionId !== null,
    state: activeSessionState,
    sessions: sessionServices,
    project: projectServices,
    sessionTabs: () => sessionTabController,
    projectActions: () => projectActions,
    startup: () => workspaceSessionStartup,
    resetWorkbench: () => {
      workbenchTerminal.reset();
      workbenchWikiConflicts.reset();
      activeWorkbenchTabId = null;
      rootEffects.resetWorkbenchTracking();
      workbenchAuxSequence = 0;
    },
    setOperationRunning: (running) => operationRunning = running,
    setErrorMessage: errors.set,
    reportError,
  });
  const workspaceController = workspaceServices.controller;
  const chooseWorkspace = workspaceController.choose;

  const conversationServices = createDesktopConversationServices({
    client: () => client,
    state: activeSessionState,
    workspace: () => workspace,
    operationRunning: () => operationRunning,
    setOperationRunning: (running) => operationRunning = running,
    promptRunning: () => {
      const id = activeSessionState.sessionId;
      return Boolean(id && userMessagePromptRunning(id));
    },
    sessionHistoryLoading: () => sessionHistoryLoading,
    sessions: sessionServices,
    sessionTabs: () => sessionTabController,
    sessionCoordinator: () => sessionCoordinator,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    clearCommandPicker: () => desktopCommands.setPicker(null),
    setCommandPicker: (picker) => desktopCommands.setPicker(picker),
    requestLocalTextInput: (message, title) => elicitationStore.requestLocalTextInput(message, title),
    beginMessageEdit: (entryId, message) => messageEdit.begin(entryId, message),
    promptText: () => promptText,
    setPromptText: (text) => promptText = text,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
    switchComposerDraft: (sourceId, targetId) => sessionTransitions.composerDrafts.switchTo(sourceId, targetId),
    invalidateAttachmentDraft: () => attachmentDrafts.invalidate(),
    nextLocalMessageId: () => `local:${++localMessageId}`,
    scrollToLatest,
    scrollToEntry: scrollToTranscriptEntry,
    scheduleScrollToLatest,
    platform: desktopShortcutPlatform,
    setErrorMessage: errors.set,
    reportError,
  });
  const conversationActions = conversationServices.actions;
  const enhancePromptDraft = conversationActions.enhancePromptDraft;
  const reloadResources = conversationActions.reloadResources;
  const branchActions = conversationServices.branches;
  const forkConversation = branchActions.forkConversation;
  const runUserMessageContextAction = branchActions.runUserMessageContextAction;

  const modelServices = createDesktopModelServices({
    client: () => client,
    workspace: () => workspace,
    statusReady: () => status === "ready",
    operationRunning: () => operationRunning,
    changingConfig: () => changingConfig,
    state: activeSessionState,
    sessions: sessionServices,
    draftSession: () => draftSession,
    closeCommandPicker: () => desktopCommands.setPicker(null),
    focusComposer: () => promptComposer?.focus(),
    reloadResources,
    reportError,
  });
  const modelConfig = modelServices.config;
  const draftConfigOptions = $derived(modelConfig.draftConfigOptions);
  const refreshDraftConfig = modelConfig.refreshDraftConfig;
  const openModelThinkingPicker = modelConfig.openPicker;

  const conversationNavigation = conversationServices.navigation;

  const commandServices = createDesktopCommandServices({
    platform: desktopShortcutPlatform,
    activeFormElicitation: () => activePendingElicitation?.kind === "form",
    anyPromptRunning: () => anyPromptRunning,
    sessionMutationRunning: () => sessionMutationRunning,
    tasksSaving: () => tasksSaving,
    taskActionId: () => taskActionId,
    activeConversationWorkbenchTabId: () => activeConversationWorkbenchTabId,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    activeWorkbenchTabKind: () => activeWorkbenchTab?.kind,
    workbenchTabs: () => workbenchTabs,
    previewOpen: () => !!activePreview,
    gitDiffOpen: () => !!gitDiffPreview,
    canUseSession: () => canUseSession,
    statusReady: () => status === "ready",
    workspace: () => workspace,
    clientAvailable: () => !!client,
    state: activeSessionState,
    draftSession: () => draftSession,
    changingConfig: () => changingConfig,
    sessionSelectorOpen: () => sessionSelectorOpen,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    sessionTabs: () => sessionTabController,
    model: modelServices,
    chooseWorkspace,
    workbenchController: () => workbenchController,
    conversation: conversationServices,
    focusComposer: () => promptComposer?.focus(),
    setPromptText: (text) => promptText = text,
  });
  const desktopCommands = commandServices.controller;

  const interactionServices = createDesktopInteractionServices({
    workspace: () => workspace,
    state: activeSessionState,
    draftSessionTabActive: () => draftSession.active,
    sessionMutationRunning: () => sessionMutationRunning,
    operationRunning: () => operationRunning,
    attachmentDraftKey: () => attachmentDraftKey,
    promptAttachments: () => promptAttachments,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
    activateAttachment: projectServices.preview.activateAttachment,
    onPendingElicitation: (pending) => agentNotifications.needsInput(pending.sessionId, pending.message),
    setErrorMessage: errors.set,
    reportError,
  });
  const attachmentDrafts = interactionServices.attachments;
  const chooseAttachments = attachmentDrafts.chooseAttachments;
  const addPastedAttachments = attachmentDrafts.addPastedAttachments;
  const invalidateAttachmentDraft = attachmentDrafts.invalidate;
  const removeAttachment = attachmentDrafts.removeAttachment;
  const nextAttachmentId = attachmentDrafts.nextAttachmentId;

  const sessionTransitions = createDesktopSessionTransitionServices({
    client: () => client,
    workspace: () => workspace,
    statusReady: () => status === "ready",
    operationRunning: () => operationRunning,
    setOperationRunning: (running) => operationRunning = running,
    canUseSession: () => canUseSession,
    sessionMutationRunning: () => sessionMutationRunning,
    state: activeSessionState,
    sessions: sessionServices,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    resetModelDraft: modelConfig.resetDraft,
    draftConfigAvailable: () => draftConfigOptions.length > 0,
    refreshDraftConfig,
    draftModelOverride: () => modelConfig.draftModelOverride,
    routeDraftModel: modelConfig.routeDraftModel,
    clearPrompt: () => promptText = "",
    invalidateAttachmentDraft,
    promptText: () => promptText,
    promptAttachments: () => promptAttachments,
    setPromptText: (text) => promptText = text,
    replacePromptAttachments: attachmentDrafts.replaceDraftAttachments,
    focusComposer: () => promptComposer?.focus(),
    sessionCoordinator: () => sessionCoordinator,
    workbenchController: () => workbenchController,
    retargetAttachmentDraftKey: (requestWorkspace, sessionId) =>
      rootEffects.retargetAttachmentDraftKey(requestWorkspace, sessionId),
    promptRunning: promptRuntime.isRunning,
    tabSessionIds: () => tabSessions.map((session) => session.sessionId),
    refreshQueueState,
    setErrorMessage: errors.set,
    reportError,
  });
  const draftSession = sessionTransitions.draft;
  const sessionTabController = sessionTransitions.sessionTabs;
  const draftSessionTabOpen = $derived(draftSession.open);
  const draftSessionTabActive = $derived(draftSession.active);
  const draftSessionTabTouched = $derived(draftSession.touched);
  const draftSessionMaterializing = $derived(draftSession.materializing);
  const activateDraftSessionTab = draftSession.activate;
  const openSessionStartTab = draftSession.openStartTab;

  /** Startup restoration may replace the active session; plan runs wait for it. */
  let workspaceOpening = $state(false);
  const workspaceSessionStartup = createDesktopWorkspaceSessionStartup({
    client: () => client,
    workspace: () => workspace,
    sessions: sessionServices,
    draft: draftSession,
    state: activeSessionState,
    setErrorMessage: errors.set,
    reportError,
    onOpeningChange: (opening) => workspaceOpening = opening,
    promptText: () => promptText,
    promptAttachments: () => promptAttachments,
  });

  const transcriptAttachments = createTranscriptAttachmentController({
    client: () => client,
    state: activeSessionState,
  });
  const projectActionServices = createDesktopProjectActionServices({
    client: () => client,
    workspace: () => workspace,
    workspaceOpening: () => workspaceOpening,
    canUseSession: () => canUseSession,
    sessionMutationRunning: () => sessionMutationRunning,
    state: activeSessionState,
    sessions: sessionServices,
    transitions: sessionTransitions,
    project: projectServices,
    prompt: promptServices,
    attachmentDraftKey: () => attachmentDraftKey,
    attachmentGeneration: () => attachmentDrafts.generation,
    waitForAttachmentDraftSettled: attachmentDrafts.waitForSettled,
    promptText: () => promptText,
    promptAttachments: () => promptAttachments,
    setPromptText: (text) => promptText = text,
    invalidateAttachmentDraft,
    openTasksPanel: (taskId) => workspaceSidebar?.openTasksPanel(taskId),
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    setOperationRunning: (running) => operationRunning = running,
    setErrorMessage: errors.set,
    forgetRuntime: (sessionId) => sessionCoordinator.forgetRuntime(sessionId),
    prepareTranscriptAttachment: transcriptAttachments.prepare,
    imagePromptSupported: () => imagePromptSupported,
    nextLocalMessageId: () => `local:${++localMessageId}`,
    scrollToLatest,
    reportError,
  });
  const projectActions = projectActionServices.actions;
  const taskActionId = $derived(projectActions.actionId);

  const promptActionServices = createDesktopPromptActionServices({
    handoffAllowed: () => status === "ready" && !activePendingElicitation,
    retargetSessionAnchors: (sourceId, targetId) => workbenchController.retargetSessionAnchors(sourceId, targetId),
    submitMessageEdit: () => messageEdit.submit(),
    messageEditActive: () => messageEdit.active,
    cancelMessageEdit: () => messageEdit.cancel(),
    openBtw,
    workspace: () => workspace,
    client: () => client,
    state: activeSessionState,
    sessions: sessionServices,
    transitions: sessionTransitions,
    prompt: promptServices,
    attachments: attachmentDrafts,
    sessionMutationRunning: () => sessionMutationRunning,
    attachmentDraftKey: () => attachmentDraftKey,
    promptText: () => promptText,
    promptAttachments: () => promptAttachments,
    setPromptText: (text) => promptText = text,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
    imagePromptSupported: () => imagePromptSupported,
    focusComposer: () => promptComposer?.focus(),
    conversation: conversationActions,
    requestLocalTextInput: (message, title) => elicitationStore.requestLocalTextInput(message, title),
    navigation: conversationNavigation,
    forkConversation,
    openInteractiveTerminal,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    applyModelSlashCommand: modelConfig.applyModelSlashCommand,
    applyThinkingSlashCommand: modelConfig.applyThinkingSlashCommand,
    setCommandPicker: desktopCommands.setPicker,
    displayedConfigOptions: () => displayedConfigOptions,
    nextLocalMessageId: () => `local:${++localMessageId}`,
    scrollToLatest,
    setErrorMessage: errors.set,
    reportError,
  });
  const promptSubmit = promptActionServices.submit;

  async function openInteractiveTerminal(command: string): Promise<void> {
    const owner = workspace;
    if (!owner) throw new Error("Open a project before starting a terminal.");
    workbenchTerminal.show();
    await tick();
    if (workspace !== owner) throw new Error("Project changed before the terminal opened. Try again.");
    const pane = workbenchTerminalPane;
    if (!pane) throw new Error("Terminal workbench is unavailable.");
    await pane.openTerminal(command);
  }

  const previewStore = projectServices.preview;
  const activePreview = $derived(previewStore.active);

  const gitWorkspace = projectServices.git;
  const gitDiffPreview = $derived(gitWorkspace.diffPreview);

  const workbenchGitServices = createDesktopWorkbenchGitServices({
    client: () => client,
    state: activeSessionState,
    workspace: () => workspace,
    operationRunning: () => operationRunning,
    statusReady: () => status === "ready",
    sessions: sessionServices,
    transitions: sessionTransitions,
    project: projectServices,
    prompt: promptServices,
    sessionCoordinator: () => sessionCoordinator,
    tabs: () => workbenchTabs,
    activeTabId: () => activeWorkbenchTabId,
    activeConversationTabId: () => activeConversationWorkbenchTabId,
    setActiveTabId: (id) => activeWorkbenchTabId = id,
    previewPane: () => previewPane,
    closeTerminal: workbenchTerminal.close,
    closeWikiConflicts: workbenchWikiConflicts.close,
    nextLocalMessageId: () => `local:${++localMessageId}`,
    scrollToLatest,
    reportError,
    lspOnboarding,
  });
  const workbenchController = workbenchGitServices.workbench;

  async function activateNotificationSession(sessionId: string): Promise<void> {
    sessionTabAttention.clear(sessionId);
    await sessionTabController.loadSession(sessionId);
    activeWorkbenchTabId = workbenchSessionTabId(sessionId);
  }

  desktopNotifications.setActivationHandler(activateNotificationSession);

  const searchNavigation = createSearchNavigation({
    workspace: () => workspace,
    connection: () => client,
    activeSession: () => activeSessionId,
    openSetting: async (section, fieldId) => {
      if (!workspaceSidebar) throw new Error("Settings are unavailable.");
      await workspaceSidebar.openSettingsField(section, fieldId);
    },
    taskExists: async (taskId) => {
      if (projectTasks.saving) throw new Error("Tasks are being saved. Try again shortly.");
      const document = parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace }));
      return document.tasks.some(task => task.id === taskId);
    },
    openTask: async (taskId, isCurrent) => {
      if (!workspaceSidebar) throw new Error("Tasks are unavailable.");
      if (!projectTasks.document.tasks.some(task => task.id === taskId)) throw new Error("Refresh the Tasks panel and try again.");
      await workspaceSidebar.openTasksPanel(taskId, isCurrent);
    },
    loadSession: sessionTabController.loadSession,
    activateSession: (id) => { activeWorkbenchTabId = workbenchSessionTabId(id); },
    hydrate: sessionHistory.waitForHydration,
    openPlan: (path) => previewStore.openProjectFile(path, "push"),
    fileExists: async (path) => Boolean(await previewStore.validateProjectFile(path)),
    openFile: (path, range) => previewStore.openProjectFile(path, "push", range),
    openCommit: async (hit, isCurrent) => {
      if (!workspaceSidebar) throw new Error("Source Control is unavailable.");
      if (await gitWorkspace.openCommitDiff(hit.hash, isCurrent) && isCurrent()) {
        workspaceSidebar.openGitPanel(isCurrent);
      }
    },
  });
  function closeSearch() { searchNavigation.cancel(); searchOpen = false; }
  function handleWindowKeydown(event: KeyboardEvent) {
    if (!event.defaultPrevented && !event.isComposing && (isMacOS ? event.metaKey : event.ctrlKey)
      && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f" && workspace) {
      event.preventDefault();
      searchOpen = true;
      return;
    }
    desktopCommands.handleKeydown(event);
  }
  $effect(() => {
    workspace; client;
    untrack(() => { searchMemory.resetFor(workspace, client); closeSearch(); });
  });
  onDestroy(searchNavigation.cancel);

  const elicitationStore = interactionServices.elicitation;
  const cancelAllPendingElicitations = elicitationStore.cancelAll;
  const requestElicitation = elicitationStore.request;
  const cancelPendingElicitationForSession = elicitationStore.cancelForSession;

  const questionImages = interactionServices.questionImages;

  const presentationState = createDesktopPresentationState({
    workspace: () => workspace,
    statusReady: () => status === "ready",
    operationRunning: () => operationRunning,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    state: activeSessionState,
    sessions: sessionServices,
    prompt: promptServices,
    project: projectServices,
    interactions: interactionServices,
    draft: draftSession,
    tabAttention: sessionTabAttention,
    lspOnboarding,
    workbenchTerminal,
    workbenchWikiConflicts,
  });
  setContext<WikiConflictsNavigation>(WIKI_CONFLICTS_NAVIGATION_CONTEXT, {
    open: (input) => workbenchWikiConflicts.show(input),
    reveal: () => workbenchWikiConflicts.reveal(),
    get openCount() { return presentationState.wikiConflictsOpenCount; },
    inbox: workbenchWikiConflicts.inbox,
    get sidebarView() { return workbenchWikiConflicts.sidebarView; },
    set sidebarView(value) { workbenchWikiConflicts.sidebarView = value; },
  });
  const sessionMutationRunning = $derived(presentationState.sessionMutationRunning);
  const canUseSession = $derived(presentationState.canUseSession);
  const promptRunning = $derived(presentationState.promptRunning);
  const anyPromptRunning = $derived(presentationState.anyPromptRunning);
  const tabSessions = $derived(presentationState.tabSessions);
  const activeConversationWorkbenchTabId = $derived(presentationState.activeConversationWorkbenchTabId);
  const attachmentDraftKey = $derived(presentationState.attachmentDraftKey);
  function userMessagePromptRunning(sessionId: string): boolean {
    return promptRuntime.isRunning(sessionId)
      || Boolean(promptRuntime.queueItemsBySession.get(sessionId)?.some((item) => item.source === "auto" || item.source === "deferred"));
  }
  $effect(() => {
    const currentClient = client;
    const openDraftKeys = tabSessions.map((session) => `${workspace}\0${session.sessionId}`);
    untrack(() => messageEdit.prune(currentClient, openDraftKeys));
  });
  const messageEdit = createComposerMessageEdit({
    client: () => client,
    state: activeSessionState,
    draftKey: () => attachmentDraftKey,
    promptText: () => promptText,
    promptAttachments: () => promptAttachments,
    setPromptText: (text) => promptText = text,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
    invalidateAttachments: attachmentDrafts.invalidate,
    operationRunning: () => sessionMutationRunning,
    promptRunning: userMessagePromptRunning,
    historyLoading: () => sessionServices.history.loading,
    setOperationRunning: (value) => operationRunning = value,
    prepare: promptActionServices.prepareEditedMessage,
    markHistoryFullyLoaded: sessionServices.history.markFullyLoaded,
    focus: () => promptComposer?.focus(),
    reportError,
  });
  onDestroy(messageEdit.dispose);
  const activePendingElicitation = $derived(presentationState.activePendingElicitation);

  const desktopLifecycle = createDesktopLifecycleServices({
    state: activeSessionState,
    workspace: () => workspace,
    setWorkspace: (nextWorkspace) => workspace = nextWorkspace,
    setDragActive: (active) => dragActive = active,
    draftSessionTabActive: () => draftSessionTabActive,
    sessionMutationRunning: () => sessionMutationRunning,
    activePendingElicitationKind: () => activePendingElicitation?.kind,
    promptComposer: () => promptComposer,
    sessionServices,
    projectServices,
    questionImages,
    connection,
    promptServices,
    disposeTranscriptScroll: transcriptScroll.dispose,
    resetAfterDisconnect: () => sessionCoordinator.resetAfterDisconnect(),
    cancelAllPendingElicitations,
    reportError,
  });
  const workbenchTabs = $derived(presentationState.workbenchTabs);
  const activeWorkbenchTab = $derived(presentationState.activeWorkbenchTab);
  $effect.pre(() => {
    const sessionId = activeSessionId;
    const visible = activeWorkbenchTab?.kind === "session";
    untrack(() => {
      transcriptScroll.setVisible(visible);
      transcriptScroll.activateSession(sessionId);
    });
  });
  const dcpCompressionAvailable = $derived(presentationState.dcpCompressionAvailable);
  const sessionOrchestration = createDesktopSessionOrchestration({
    client: () => client,
    activeSessionId: () => activeSessionId,
    operationRunning: () => operationRunning,
    sessionHistoryLoading: () => sessionHistoryLoading,
    dcpCompressionAvailable: () => dcpCompressionAvailable,
    state: activeSessionState,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    closeSessionSelector: () => sessionTabController.closeSessionSelector(),
    clearCommandPicker: () => desktopCommands.setPicker(null),
    cancelAllPendingElicitations,
    cancelPendingElicitationForSession,
    setOperationRunning: (running) => operationRunning = running,
    sessionServices,
    projectServices,
    promptServices,
    lspOnboarding,
    quotaWait,
    headsUp,
    btw,
    backgroundJobs,
    reportError,
  });
  const sessionCoordinator = sessionOrchestration.coordinator;
  const displayedConfigOptions = $derived(draftSessionTabActive ? draftConfigOptions : configOptions);
  const rootEffects = createDesktopRootEffects({
    statusReady: () => status === "ready",
    registryStartupState: () => ({
      ready: status === "ready",
      client,
      workspace,
      blocked: operationRunning || projectServices.registry.actionId !== null
        || projectServices.registry.backgroundSyncState.phase === "syncing"
        || projectServices.registry.resourceAutoPushState.phase === "syncing",
    }),
    refreshRegistry: () => void projectServices.registry.refresh(),
    activeSessionId: () => activeSessionId,
    activeSessionRuntimeReady: () => activeSessionRuntimeReady,
    configOptions: () => configOptions,
    refreshRuntimeStatus,
    attachmentDraftKey: () => attachmentDraftKey,
    workspace: () => workspace,
    invalidateAttachmentDraft,
    bumpAttachmentGeneration: attachmentDrafts.bumpGeneration,
    invalidatePreviewFileLoads: previewStore.invalidateFileLoads,
    resetPreviewForWorkspaceChange: previewStore.resetForWorkspaceChange,
    activeConversationWorkbenchTabId: () => activeConversationWorkbenchTabId,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    workbenchTabs: () => workbenchTabs,
    markSessionTabViewed: (sessionId) => {
      sessionTabAttention.clear(sessionId);
      trayAttention.acknowledgeVisible();
    },
  });
  const viewModels = createDesktopViewModelServices({
    openBtw: (sessionId) => openBtw(sessionId).catch(reportError),
    explainFile: (path, content, anchor) => {
      const open = selectionAssist.state.target;
      if (open?.action === "explain-file" && open.path === path) { selectionAssist.close(); return; }
      const target = explainFileTarget(path, content, anchor);
      if (target) void selectionAssist.run(target);
    },
    focusComposer: () => promptComposer?.focus(),
    platform: desktopShortcutPlatform,
    workspace: () => workspace,
    status: () => status,
    clientAvailable: () => Boolean(client),
    client: () => client,
    workspaceOpening: () => workspaceOpening,
    operationRunning: () => operationRunning,
    dragActive: () => dragActive,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    promptText: () => promptText,
    setPromptText: (text) => promptText = text,
    promptAttachments: () => promptAttachments,
    changingConfig: () => changingConfig,
    displayedConfigOptions: () => displayedConfigOptions,
    reconnect,
    state: activeSessionState,
    errors,
    sessions: sessionServices,
    project: projectServices,
    prompt: promptServices,
    transitions: sessionTransitions,
    conversation: conversationServices,
    promptActions: promptActionServices,
    projectActions: projectActionServices,
    workbenchGit: workbenchGitServices,
    model: modelServices,
    commands: commandServices,
    interactions: interactionServices,
    presentation: presentationState,
    workspaceController,
    transcriptScroll,
    transcriptAttachments,
    orchestration: sessionOrchestration,
    lspOnboarding,
    workbenchWikiConflicts,
    quotaWait,
    headsUp,
    backgroundJobs,
    openObserverSettings: () => void workspaceSidebar?.openSettingsSection("desktop-observer"),
    openProjectSettings: () => workspaceSidebar?.openProjectSettings(),
    openTasksPanel: (taskId) => workspaceSidebar?.openTasksPanel(taskId),
    openClaudeLoginTerminal: openInteractiveTerminal,
  });
  const titlebarViewModel = viewModels.titlebar;
  const sidebarViewModel = viewModels.sidebar;
  const workbenchViewModel = viewModels.workbench;
  const overlaysViewModel = viewModels.overlays;
  const statusBarViewModel = viewModels.statusBar;

  const sessionRename = createSessionRename({
    client: () => client,
    workspace: () => workspace,
    sessions: () => sessionCatalog.sessions,
    isOpen: (id) => tabSessions.some((session) => session.sessionId === id),
    isBusy: (id) => promptRuntime.runningSessionIds.has(id),
    ensureRuntime: sessionServices.runtime.ensure,
    runtimeReady: sessionServices.runtime.isReady,
    refreshSessions: sessionCatalog.refresh,
    reportError,
  });
  $effect(() => sessionRename.reconcile());
  onDestroy(sessionRename.cancel);

  const selectionAssist = createSelectionAssistStore({ client: () => client, workspace: () => workspace, report: (error, label) => diagnosticLogger.warn(label ?? "frontend:selection-assist", error) });
  $effect(() => { void workspace; return () => selectionAssist.close(); });
  onDestroy(selectionAssist.close);
  onMount(() => installDesktopContextMenu({
    reportError, workspace: () => workspace,
    selectionAssist: (target) => void selectionAssist.run(target),
    sessionActions: sessionRename,
    revealProjectEntry: async (path) => { await workspaceSidebar?.revealProjectEntry(path); },
  }));
  onMount(desktopLifecycle.start);
  onMount(diagnosticLogger.start);
  onMount(() => toasts.setReporter(diagnosticLogger.report));
  onMount(() => startThemePreference((error) => diagnosticLogger.warn("frontend:theme-preference", error)));
  onDestroy(headsUp.reset);
  onDestroy(backgroundJobs.reset);
  onDestroy(btw.reset);
  onMount(desktopNotifications.start);
  onMount(trayAttention.start);
  onMount(() => desktopUpdaterEnabled ? updater.start() : updater.dispose);
  onMount(desktopWatchRestart.start);

  const windowRunActivity = createWindowRunActivitySync(
    (running, restartBlocking) => invoke("desktop_set_running_activity", { running, restartBlocking }),
    reportError,
  );
  $effect(() => {
    if (isTauri()) windowRunActivity.update(
      promptRuntime.runningSessionIds.size > 0 || draftSessionMaterializing,
      hasRestartBlockingRun(
        promptRuntime.runningSessionIds,
        interactionServices.elicitation.pendingBySession,
        interactionServices.elicitation.pendingUnscoped,
        activeSessionState.sessionId,
        draftSessionMaterializing,
      ),
    );
  });
  onMount(() => windowRunActivity.dispose);

</script>

<svelte:window onkeydown={handleWindowKeydown} />
<svelte:head><title>Pix Desktop</title></svelte:head>

<div class="desktop-workspace-chrome grid h-full grid-rows-[36px_minmax(0,1fr)_28px] bg-background text-foreground"
  class:project-window-titlebar={Boolean(sidebarViewModel.projectSwitcher?.workspace)}
  style:--project-window-titlebar-color={sidebarViewModel.projectSwitcher?.projectColors.get(sidebarViewModel.projectSwitcher.workspace)}
  style:--project-window-titlebar-hue={sidebarViewModel.projectSwitcher?.workspace ? projectFolderHue(sidebarViewModel.projectSwitcher.workspace) : undefined}
>
  <DesktopTitlebar
    {isMacOS}
    restartAvailable={desktopWatchRestart.available}
    restartPending={desktopWatchRestart.restarting}
    buildStatus={desktopWatchRestart.buildStatus}
    onRestart={desktopWatchRestart.restart}
    onSearch={workspace ? () => { searchOpen = true; } : undefined}
    projectSwitcher={sidebarViewModel.projectSwitcher}
    workbench={titlebarViewModel.workbench}
    selector={titlebarViewModel.selector}
  />

  <div class="flex min-h-0 min-w-0">
    <DesktopSidebar bind:instance={workspaceSidebar} props={sidebarViewModel.props} />
    <div class="flex min-h-0 min-w-0 flex-1" data-btw-workspace>
    <DesktopWorkbenchSurface
      {...workbenchViewModel.props}
      bind:transcriptPane
      bind:transcriptContent
      bind:promptComposer
      bind:promptText
      bind:previewPane
      bind:terminalPane={workbenchTerminalPane}
    />
    <BtwDock bind:this={btwDock} store={btw} sessionId={activeSessionId}
      preferences={modelServices.preferences} mainPickerOpen={modelConfig.pickerOpen} beforeModelOpen={modelConfig.closePicker}
      {configOptions} ready={activeSessionRuntimeReady} onInsert={insertBtwAnswer}
      onReturnFocus={() => void promptComposer?.focus()} />
    </div>
  </div>

  <DesktopStatusBar props={statusBarViewModel.props} />
</div>

<DesktopOverlays {...overlaysViewModel.props} />
<!-- Outside the app shell so its clipping/stacking never cuts the popover. -->
<SelectionAssistPopover store={selectionAssist} />
{#if searchOpen}
  <UniversalSearch {workspace} {client} memory={searchMemory} onSelect={searchNavigation.open}
    onClose={closeSearch}
    onPreferences={() => {
      closeSearch();
      void workspaceSidebar?.openSettingsField("desktop-assistant", "rag-answer-model").catch(reportError);
    }} />
{/if}
<DesktopBootstrapDialog onCredentialsChanged={reconnect} />
<DeleteConfirmationHost />
{#if sessionRename.request}
  <SessionRenameDialog title={sessionRename.request.title} saving={sessionRename.saving}
    onconfirm={(name) => void sessionRename.submit(name)} oncancel={sessionRename.cancel} {reportError} />
{/if}
<ModelSetupDialog client={client ?? undefined} onApplied={reconnect} catalog={modelThinkingConfigState(displayedConfigOptions).models} />
<DesktopUpdateBanner {updater} />
<ToastViewport />
