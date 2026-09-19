<script lang="ts">
  import { onMount } from "svelte";
  import { installDesktopContextMenu } from "./lib/desktop-context-menu";
  import type { DesktopShortcutPlatform } from "./lib/desktop-commands";
  import type { Attachment } from "./lib/attachments";
  import DesktopTitlebar from "./components/DesktopTitlebar.svelte";
  import DesktopSidebar from "./components/DesktopSidebar.svelte";
  import DesktopWorkbenchSurface from "./components/DesktopWorkbenchSurface.svelte";
  import DesktopOverlays from "./components/DesktopOverlays.svelte";
  import DesktopStatusBar from "./components/DesktopStatusBar.svelte";
  import DesktopUpdateBanner from "./components/DesktopUpdateBanner.svelte";
  import DesktopBootstrapDialog from "./components/DesktopBootstrapDialog.svelte";
  import { workbenchSessionTabId, type WorkbenchTabId } from "./lib/workbench-tabs";
  import { createTranscriptAttachmentController } from "./app/transcript-attachments";
  import { createTranscriptScrollController } from "./app/transcript-scroll.svelte";
  import { createErrorState } from "./app/error-state.svelte";
  import { createActiveSessionState } from "./app/active-session-state.svelte";
  import { createDesktopSessionServices } from "./app/desktop-session-services";
  import { createDesktopProjectServices } from "./app/desktop-project-services";
  import { createDesktopConnectionServices } from "./app/desktop-connection-services";
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
  import { createDesktopViewModelServices } from "./app/desktop-view-model-services";
  import {
    createDesktopAgentNotificationCoordinator,
    createDesktopNotificationService,
  } from "./lib/desktop-notifications";
  import { createDesktopUpdater } from "./app/desktop-updater.svelte";

  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const desktopShortcutPlatform: DesktopShortcutPlatform = isMacOS ? "mac" : "other";
  const desktopUpdaterEnabled = import.meta.env.VITE_PIX_DESKTOP_UPDATER === "1";

  let workspace = $state("");
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
  let previewPane = $state<{ requestClose: () => boolean } | null>(null);
  let transcriptPane = $state<HTMLDivElement | null>(null);
  let transcriptContent = $state<HTMLDivElement | null>(null);
  let promptComposer = $state<{
    focus: () => Promise<void>;
    insertPaths: (paths: readonly string[]) => Promise<void>;
  } | null>(null);
  let workspaceSidebar = $state<{
    openTasksPanel: (taskId?: string) => Promise<void>;
    openTerminal: (command: string) => Promise<void>;
    closeProjectSwitcher: () => void;
  } | null>(null);
  let localMessageId = 0;
  let onSessionActivityChanged = (_sessionId: string): void => {};

  const errors = createErrorState();
  const reportError = errors.report;
  const updater = createDesktopUpdater();

  const transcriptScroll = createTranscriptScrollController({
    activeSessionId: () => activeSessionId,
    pane: () => transcriptPane,
    content: () => transcriptContent,
  });
  const transcriptFollowsLatest = $derived(transcriptScroll.followsLatest);
  const scheduleScrollToLatest = transcriptScroll.scheduleScrollToLatest;
  const scrollToLatest = transcriptScroll.scrollToLatest;
  const scrollToTranscriptEntry = transcriptScroll.scrollToEntry;

  const connection = createDesktopConnectionServices({
    workspace: () => workspace,
    sessionCoordinator: () => sessionCoordinator,
    promptRuntime: () => promptRuntime,
    workspaceSessionStartup: () => workspaceSessionStartup,
    requestElicitation: (request) => requestElicitation(request),
    setErrorMessage: errors.set,
    reportError,
  });
  const client = $derived(connection.client);
  const status = $derived(connection.status);
  const diagnostics = $derived(connection.diagnostics);
  const imagePromptSupported = $derived(connection.imagePromptSupported);
  const reconnect = connection.reconnect;

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
    reportError,
  });
  const sessionActivity = sessionServices.activity;

  const sessionInspectorPreference = sessionServices.inspectorPreference;
  const sessionInspectorOpen = $derived(sessionInspectorPreference.open);
  const setSessionInspectorOpen = sessionInspectorPreference.setOpen;

  const sessionTabsState = sessionServices.tabs;
  const sessionSelectorOpen = $derived(sessionTabsState.selectorOpen);
  const sessionSelectorQuery = $derived(sessionTabsState.selectorQuery);
  const sessionSelectorMode = $derived(sessionTabsState.selectorMode);

  const sessionCatalog = sessionServices.catalog;
  const sessions = $derived(sessionCatalog.sessions);
  const sessionTabAttention = createSessionTabAttentionStore();

  const nativeNotifications = createDesktopNotificationService();
  const agentNotifications = createDesktopAgentNotificationCoordinator({
    notifications: nativeNotifications,
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
    },
    onPromptSettled: agentNotifications.promptSettled,
    onPromptError: agentNotifications.promptError,
    onSessionCleared: (sessionId) => {
      sessionTabAttention.clear(sessionId);
      agentNotifications.clearSession(sessionId);
    },
    onReset: () => {
      sessionTabAttention.reset();
      agentNotifications.reset();
    },
  });
  const promptRuntime = promptServices.runtime;
  const queuedMessages = promptServices.queue;
  const queueItemsBySession = $derived(promptRuntime.queueItemsBySession);
  const refreshQueueState = promptRuntime.refreshQueueState;

  const projectServices = createDesktopProjectServices({
    client: () => client,
    workspace: () => workspace,
    activeSessionId: () => activeSessionId,
    activeSessionRuntimeReady: () => activeSessionRuntimeReady,
    operationRunning: () => operationRunning,
    promptRunning: () => promptRunning,
    sessionHistoryLoading: () => sessionHistoryLoading,
    sessionWorkspace: (sessionId) => sessions.find((session) => session.sessionId === sessionId)?.cwd,
    transcript: () => transcript,
    prepareAttachment: (attachment) => transcriptAttachments.prepare(attachment),
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    activeConversationWorkbenchTabId: () => activeConversationWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    nextWorkbenchAuxOrder: () => ++workbenchAuxSequence,
    setOperationRunning: (running) => operationRunning = running,
    setErrorMessage: errors.set,
    clearError: errors.clear,
    reportError,
  });
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
    promptRunning: () => promptRunning,
    sessionHistoryLoading: () => sessionHistoryLoading,
    sessions: sessionServices,
    sessionTabs: () => sessionTabController,
    sessionCoordinator: () => sessionCoordinator,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    clearCommandPicker: () => desktopCommands.setPicker(null),
    setCommandPicker: (picker) => desktopCommands.setPicker(picker),
    requestLocalTextInput: (message, title) => elicitationStore.requestLocalTextInput(message, title),
    setPromptText: (text) => promptText = text,
    setPromptAttachments: (attachments) => promptAttachments = attachments,
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
    sessionInspectorOpen: () => sessionInspectorOpen,
    sessionSelectorOpen: () => sessionSelectorOpen,
    closeProjectSelector: () => workspaceSidebar?.closeProjectSwitcher(),
    sessionTabs: () => sessionTabController,
    model: modelServices,
    chooseWorkspace,
    workbenchController: () => workbenchController,
    conversation: conversationServices,
    setSessionInspectorOpen,
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
    clearPrompt: () => promptText = "",
    invalidateAttachmentDraft,
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

  const workspaceSessionStartup = createDesktopWorkspaceSessionStartup({
    client: () => client,
    workspace: () => workspace,
    sessions: sessionServices,
    draft: draftSession,
    state: activeSessionState,
    setOperationRunning: (running) => operationRunning = running,
    setErrorMessage: errors.set,
    reportError,
  });

  const transcriptAttachments = createTranscriptAttachmentController({
    client: () => client,
    state: activeSessionState,
  });
  const projectActionServices = createDesktopProjectActionServices({
    client: () => client,
    workspace: () => workspace,
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
    openInteractiveTerminal: async (command) => { await workspaceSidebar?.openTerminal(command); },
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
    nextLocalMessageId: () => `local:${++localMessageId}`,
    scrollToLatest,
    reportError,
  });
  const workbenchController = workbenchGitServices.workbench;

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
  });
  const sessionMutationRunning = $derived(presentationState.sessionMutationRunning);
  const canUseSession = $derived(presentationState.canUseSession);
  const promptRunning = $derived(presentationState.promptRunning);
  const anyPromptRunning = $derived(presentationState.anyPromptRunning);
  const tabSessions = $derived(presentationState.tabSessions);
  const activeConversationWorkbenchTabId = $derived(presentationState.activeConversationWorkbenchTabId);
  const attachmentDraftKey = $derived(presentationState.attachmentDraftKey);
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
    cancelAllPendingElicitations,
    reportError,
  });
  const workbenchTabs = $derived(presentationState.workbenchTabs);
  const activeWorkbenchTab = $derived(presentationState.activeWorkbenchTab);
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
    reportError,
  });
  const sessionCoordinator = sessionOrchestration.coordinator;
  const displayedConfigOptions = $derived(draftSessionTabActive ? draftConfigOptions : configOptions);
  const rootEffects = createDesktopRootEffects({
    statusReady: () => status === "ready",
    activeSessionId: () => activeSessionId,
    activeSessionRuntimeReady: () => activeSessionRuntimeReady,
    configOptions: () => configOptions,
    refreshRuntimeStatus,
    attachmentDraftKey: () => attachmentDraftKey,
    workspace: () => workspace,
    invalidateAttachmentDraft,
    invalidatePreviewFileLoads: previewStore.invalidateFileLoads,
    resetPreviewForWorkspaceChange: previewStore.resetForWorkspaceChange,
    activeConversationWorkbenchTabId: () => activeConversationWorkbenchTabId,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    setActiveWorkbenchTabId: (id) => activeWorkbenchTabId = id,
    workbenchTabs: () => workbenchTabs,
    activeTodoSnapshot: () => presentationState.activeTodoSnapshot,
    activeSubagentSnapshot: () => presentationState.activeSubagentSnapshot,
    setSessionInspectorOpen,
    markSessionTabViewed: sessionTabAttention.clear,
  });
  const viewModels = createDesktopViewModelServices({
    platform: desktopShortcutPlatform,
    workspace: () => workspace,
    status: () => status,
    clientAvailable: () => Boolean(client),
    client: () => client,
    operationRunning: () => operationRunning,
    dragActive: () => dragActive,
    activeWorkbenchTabId: () => activeWorkbenchTabId,
    promptText: () => promptText,
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
  });
  const titlebarViewModel = viewModels.titlebar;
  const sidebarViewModel = viewModels.sidebar;
  const workbenchViewModel = viewModels.workbench;
  const overlaysViewModel = viewModels.overlays;
  const statusBarViewModel = viewModels.statusBar;

  onMount(() => installDesktopContextMenu({ reportError }));
  onMount(desktopLifecycle.start);
  onMount(() => desktopUpdaterEnabled ? updater.start() : updater.dispose);

</script>

<svelte:window onkeydown={desktopCommands.handleKeydown} />
<svelte:head><title>Pix Desktop</title></svelte:head>

<div class="grid h-full grid-rows-[36px_minmax(0,1fr)_28px] bg-background text-foreground">
  <DesktopTitlebar {isMacOS} workbench={titlebarViewModel.workbench} selector={titlebarViewModel.selector} />

  <div class="flex min-h-0 min-w-0">
    <DesktopSidebar bind:instance={workspaceSidebar} props={sidebarViewModel.props} />
    <DesktopWorkbenchSurface
      {...workbenchViewModel.props}
      bind:transcriptPane
      bind:transcriptContent
      bind:promptComposer
      bind:promptText
      bind:previewPane
    />
  </div>

  <DesktopStatusBar props={statusBarViewModel.props} />
</div>

<DesktopOverlays {...overlaysViewModel.props} />
<DesktopBootstrapDialog onCredentialsChanged={reconnect} />
<DesktopUpdateBanner {updater} />
