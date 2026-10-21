import { planRunResumable, planRunStatus } from "../lib/plan-launches";
import { createDesktopOverlaysViewModel } from "./desktop-overlays-view-model.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import type { createSessionTodoActions } from "./session-todo-actions";
import { invoke } from "@tauri-apps/api/core";
import { planOwners } from "../lib/project-task-plans";
import { projectTaskDisplayLabel } from "../lib/project-tasks";
import type { SubagentSessionNavigation } from "./desktop-subagent-navigation";
import { createSessionStepNavigation } from "./session-step-navigation";

export function createDesktopShellViewModelServices(
  options: DesktopViewModelServicesOptions,
  todoActions: ReturnType<typeof createSessionTodoActions>,
  subagentNavigation?: SubagentSessionNavigation,
) {
  const overlays = createDesktopOverlaysViewModel({
    workspace: options.workspace,
    pendingElicitation: () => options.presentation.activePendingElicitation,
    displayedConfigOptions: options.displayedConfigOptions,
    canUseSession: () => options.presentation.canUseSession,
    changingConfig: options.changingConfig,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeSessionId: () => options.state.sessionId,
    elicitation: options.interactions.elicitation,
    commands: options.commands.controller,
    modelConfig: options.model.config,
    preferences: options.model.preferences,
    quotaWait: options.quotaWait,
    focusComposer: options.focusComposer,
  });

  const stepNavigation = createSessionStepNavigation({
    activeSessionId: () => options.state.sessionId,
    transcript: () => options.state.transcript,
    loadOlder: options.sessions.history.loadOlder,
    revealActivityEntry: options.transcriptScroll.revealActivityEntry,
    reportError: (error) => options.errors.report(error),
  });

  const statusBar = createDesktopStatusBarViewModel({
    status: options.status,
    workspace: options.workspace,
    tabs: options.sessions.tabs,
    displayedConfigOptions: options.displayedConfigOptions,
    changingConfig: options.changingConfig,
    promptRunning: () => options.presentation.promptRunning,
    canUseSession: () => options.presentation.canUseSession,
    sessionHistoryLoading: () => options.sessions.history.loading,
    draftSessionTabActive: () => options.transitions.draft.active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeSessionId: () => options.state.sessionId,
    sessionActivity: () => options.presentation.activeSessionActivity,
    sessionSubagentSnapshot: () => options.presentation.activeSubagentSnapshot,
    sessionTodoSnapshot: () => options.presentation.activeTodoSnapshot,
    sessionNeedsInput: () => options.presentation.activePendingElicitation !== null,
    canClearTodos: () => Boolean(
      options.state.sessionId && todoActions.canClear(options.state.sessionId),
    ),
    clearSessionTodos: todoActions.clear,
    sessionPlan: (workspace, sessionId) => {
      const launches = options.project.planLaunches;
      const launch = launches.launch(workspace, sessionId);
      const snapshot = options.project.documents.snapshot;
      // A deleted/renamed plan simply drops the HUD context.
      if (!launch || !snapshot.plans.includes(launch.path)) return undefined;
      const path = launch.path;
      const owner = planOwners(options.project.tasks.document.tasks)[path];
      const running = options.prompt.runtime.runningSessionIds;
      const progress = snapshot.planProgress?.[path] ?? null;
      const status = planRunStatus(launch, launch.live || running.has(sessionId), progress);
      // Resume only from the newest run of the plan, and never while one is active.
      const runs = launches.sessionsFor(workspace, path);
      const resumable = planRunResumable(status)
        && runs[0]?.sessionId === sessionId
        && !runs.some((run) => run.live || running.has(run.sessionId));
      return { path, progress, status, resumable, ...(owner ? { task: projectTaskDisplayLabel(owner) } : {}) };
    },
    resumePlan: (path) => void options.projectActions.actions.resumePlan(path),
    canJumpToSteps: () => options.state.runtimeReady && !options.sessions.history.loading,
    jumpToStep: (sessionId, task) => void stepNavigation.jumpToStep(sessionId, task),
    planRunDisabled: () => !(options.status() === "ready" && options.clientAvailable() && !options.workspaceOpening?.())
      || !options.presentation.canUseSession || options.presentation.sessionMutationRunning
      || options.projectActions.actions.actionId !== null,
    openPlan: (path) => options.project.documents.open(path),
    refreshPlans: options.project.documents.refresh,
    runtime: options.sessions.runtime,
    modelConfig: options.model.config,
    sessionCoordinator: options.orchestration.coordinator,
    quotaWait: options.quotaWait,
    headsUp: options.headsUp,
    openObserverSettings: options.openObserverSettings,
    subagentViewerState: subagentNavigation?.viewerState,
    openSubagentSession: subagentNavigation
      ? (runDir, agentId) => void subagentNavigation.openSubagentSession(runDir, agentId)
      : undefined,
    subagentPathNavigation: {
      validate: async (path, kind) => kind === "directory"
        ? invoke<boolean>("project_directory_exists", { workspace: options.workspace(), path })
        : Boolean(await options.project.preview.validateProjectFile(path)),
      open: (path) => options.project.preview.openProjectFile(path, "push"),
    },
  });

  return { overlays, statusBar };
}
