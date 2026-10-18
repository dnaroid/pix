import type { ComponentProps } from "svelte";
import DesktopStatusBar from "../components/DesktopStatusBar.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createSessionCoordinator } from "./session-coordinator";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { QuotaWaitStore } from "./quota-wait.svelte";
import type { HeadsUpStore } from "./heads-up.svelte";
import { shouldShowStatusBarSkeletons, type StatusBarConnectionStatus } from "./status-bar-skeleton";
import {
  quotaWaitStatusLabel,
} from "../lib/quota-wait";
import { modelThinkingConfigState } from "../lib/model-thinking";
import { sessionTabModelDisplayOptions } from "../lib/session-tab-model";
import type { createSessionTabsState } from "./session-tabs-state.svelte";
import { scopedProjectPathNavigation, type ProjectPathNavigation } from "../lib/project-path-navigation";
import type { SubagentSessionState } from "../lib/session-subagent-link";
import { sessionActivitySummary } from "../lib/session-activity";
import type { SessionTodoTask } from "../lib/session-todos";

type StatusBarProps = ComponentProps<typeof DesktopStatusBar>["props"];

export function createDesktopStatusBarViewModel(options: {
  status: () => StatusBarConnectionStatus;
  displayedConfigOptions: () => StatusBarProps["configOptions"];
  workspace: () => string;
  tabs: ReturnType<typeof createSessionTabsState>;
  changingConfig: () => string | null;
  promptRunning: () => boolean;
  canUseSession: () => boolean;
  sessionHistoryLoading: () => boolean;
  draftSessionTabActive: () => boolean;
  draftConfigAvailable: () => boolean;
  activeSessionRuntimeReady: () => boolean;
  activeSessionId: () => string | null;
  sessionActivity: () => StatusBarProps["sessionActivity"];
  sessionSubagentSnapshot: () => StatusBarProps["sessionSubagentSnapshot"];
  sessionTodoSnapshot: () => StatusBarProps["sessionTodoSnapshot"];
  sessionNeedsInput: () => boolean;
  canClearTodos: () => boolean;
  clearSessionTodos: (sessionId: string) => Promise<boolean>;
  sessionPlan?: (workspace: string, sessionId: string) => StatusBarProps["sessionPlan"];
  openPlan?: (path: string) => void;
  refreshPlans?: () => Promise<void>;
  resumePlan?: (path: string) => void;
  planRunDisabled?: () => boolean;
  /** Session step actions (HUD): jump to where a step started, rerun one step. */
  canJumpToSteps?: () => boolean;
  canRerunSteps?: () => boolean;
  jumpToStep?: (sessionId: string, task: SessionTodoTask) => void;
  rerunStep?: (sessionId: string, task: SessionTodoTask) => void;
  runtime: ReturnType<typeof createSessionRuntimeStore>;
  modelConfig: ReturnType<typeof createModelConfig>;
  sessionCoordinator: ReturnType<typeof createSessionCoordinator>;
  quotaWait: QuotaWaitStore;
  headsUp: HeadsUpStore;
  openObserverSettings: () => void;
  openSubagentSession?: (runDir: string, agentId: string) => void;
  subagentPathNavigation?: ProjectPathNavigation;
  /** Display state of a read-only sub-agent viewer (no Pi runtime). */
  subagentViewerState?: (sessionId: string) => SubagentSessionState | undefined;
}) {
  const props = $derived.by<StatusBarProps>(() => {
    const sessionId = options.activeSessionId();
    const draft = options.draftSessionTabActive();
    const runtimeReady = options.activeSessionRuntimeReady();
    const historyLoading = options.sessionHistoryLoading();
    const changingConfig = options.changingConfig();
    const liveConfigOptions = options.displayedConfigOptions();
    const workspace = options.workspace();
    const savedTabs = options.tabs.sessionTabsForProject(workspace) ?? [];
    const remembered = options.tabs.activeForProject(workspace);
    const displaySessionId = sessionId ?? (remembered && savedTabs.includes(remembered) ? remembered : savedTabs[0]);
    const savedModel = !draft && !runtimeReady && displaySessionId
      ? options.tabs.models.get(workspace, displaySessionId) : undefined;
    const hasLiveModel = !!modelThinkingConfigState(liveConfigOptions).currentModel;
    const cachedDisplay = !hasLiveModel && savedModel;
    const draftDisplay = draft && !hasLiveModel
      ? options.modelConfig.draftDisplayConfigOptions ?? [] : [];
    const viewer = !draft && sessionId ? options.subagentViewerState?.(sessionId) : undefined;
    let displayConfigOptions = liveConfigOptions;
    if (viewer?.model) {
      displayConfigOptions = sessionTabModelDisplayOptions({
        modelRef: `${viewer.model.provider}/${viewer.model.modelId}`,
        modelName: viewer.model.name,
        thinking: viewer.model.thinking ?? "off",
      });
    } else if (cachedDisplay) displayConfigOptions = sessionTabModelDisplayOptions(cachedDisplay);
    else if (draftDisplay.length) displayConfigOptions = draftDisplay;
    const promptRunning = options.promptRunning();
    let runtimeStatus: StatusBarProps["runtimeStatus"];
    if (draft) {
      runtimeStatus = options.modelConfig.draftRuntimeStatus;
    } else if (viewer && sessionId) {
      // Display-only snapshots: never attach a runtime to the child's JSONL.
      runtimeStatus = {
        sessionId, modelUsageRefresh: viewer.modelUsageRefresh ?? "skipped",
        ...(viewer.context ? { context: viewer.context } : {}),
        ...(viewer.modelUsage ? { modelUsage: viewer.modelUsage } : {}),
        ...(viewer.modelUsageCredentialPending ? { modelUsageCredentialPending: true } : {}),
      };
    } else if (sessionId) {
      runtimeStatus = options.runtime.statuses.get(sessionId);
    }
    const connectionStatus = options.status();
    const showSkeletons = !viewer && shouldShowStatusBarSkeletons({
      connectionStatus,
      draft,
      historyLoading,
      sessionId,
      runtimeReady,
      runtimeStatusAvailable: runtimeStatus !== undefined,
    });

    const sessionActivity = viewer ? sessionActivitySummary(viewer.todo, undefined) : options.sessionActivity();
    const waitState = options.quotaWait.indicator(sessionId);
    const nowMs = options.quotaWait.nowMs;
    const observerSnapshot = draft ? undefined : options.headsUp.state(sessionId);
    const observerOwnerCurrent = () => options.activeSessionId() === sessionId
      && !options.draftSessionTabActive() && options.activeSessionRuntimeReady() && options.status() === "ready"
      && (!observerSnapshot || options.headsUp.state(sessionId)?.instanceId === observerSnapshot.instanceId);

    return {
      showSkeletons,
      configOptions: displayConfigOptions,
      changingConfig,
      promptRunning,
      quotaWaitIndicator: sessionId && waitState?.autoResume ? {
        label: quotaWaitStatusLabel(waitState, nowMs),
        onReopen: () => options.quotaWait.reopen(sessionId),
      } : null,
      observer: {
        sessionId: draft ? null : sessionId,
        runtimeReady: !draft && runtimeReady && connectionStatus === "ready",
        snapshot: observerSnapshot,
        pendingToggle: !draft && (options.headsUp.isPending(sessionId, "/heads-up on") || options.headsUp.isPending(sessionId, "/heads-up off")),
        pendingCheck: !draft && options.headsUp.isPending(sessionId, "/heads-up check"),
        onToggle: () => {
          if (!observerOwnerCurrent()) return;
          const snapshot = !draft ? options.headsUp.state(sessionId) : undefined;
          if (sessionId && snapshot) void options.headsUp.sendControl(sessionId, snapshot.enabled ? "off" : "on");
        },
        onCheck: () => { if (sessionId && observerOwnerCurrent()) void options.headsUp.sendControl(sessionId, "check"); },
        onRequestSnapshot: () => { if (sessionId && observerOwnerCurrent()) void options.headsUp.requestSnapshot(sessionId); },
        onOpenSettings: options.openObserverSettings,
      },
      canConfigure: !viewer && !cachedDisplay && !draftDisplay.length && options.canUseSession()
        && !historyLoading
        && (draft ? options.draftConfigAvailable() : runtimeReady),
      modelThinkingOpen: options.modelConfig.pickerOpen,
      runtimeStatus,
      sessionUsage: !draft && sessionId ? options.runtime.sessionUsageBySession.get(sessionId) : undefined,
      sessionUsageRefreshing: !draft && sessionId ? options.runtime.sessionUsageRefreshing.has(sessionId) : false,
      sessionUsageFailed: !draft && sessionId ? options.runtime.sessionUsageFailed.has(sessionId) : false,
      sessionUsageAvailable: !viewer && !draft && !!sessionId && runtimeReady,
      // The manual Claude Code limit refresh exists only for a live (non-draft)
      // session whose active model routes through pi-claude-code-provider.
      claudeCodeRoute: !!sessionId
        && !viewer
        && !draft
        && modelThinkingConfigState(liveConfigOptions).currentModel?.provider === "pi-claude-code-provider",
      lastClaudeAccountAttempt: sessionId && !draft ? options.runtime.claudeAccountAttempts.get(sessionId)?.name : undefined,
      claudeLimitsRefreshing: sessionId ? options.runtime.claudeLimitsRefreshing.has(sessionId) : false,
      claudeLimitsFailed: sessionId ? options.runtime.claudeLimitsFailed.has(sessionId) : false,
      sessionActivity,
      sessionSubagentSnapshot: viewer ? undefined : options.sessionSubagentSnapshot(),
      sessionTodoSnapshot: viewer ? viewer.todo : options.sessionTodoSnapshot(),
      onOpenSubagentSession: options.openSubagentSession,
      sessionNeedsInput: options.sessionNeedsInput(),
      canClearTodos: !viewer && options.canClearTodos(),
      sessionPlan: !viewer && !draft && sessionId ? options.sessionPlan?.(workspace, sessionId) : undefined,
      onOpenPlan: options.openPlan,
      onRefreshPlans: options.refreshPlans,
      onResumePlan: options.resumePlan,
      planRunDisabled: options.planRunDisabled?.() ?? false,
      canJumpToSteps: !viewer && !draft && !!sessionId && !!options.jumpToStep && (options.canJumpToSteps?.() ?? false),
      canRerunSteps: !viewer && !draft && !!sessionId && !!options.rerunStep && (options.canRerunSteps?.() ?? false),
      onJumpToStep: sessionId && options.jumpToStep ? (task) => options.jumpToStep!(sessionId, task) : undefined,
      onRerunStep: sessionId && options.rerunStep ? (task) => options.rerunStep!(sessionId, task) : undefined,
      onSetConfig: (option, value) => void options.modelConfig.setConfig(option, value),
      onOpenModelThinking: options.modelConfig.openPicker,
      onOpenSessionUsage: () => { if (!viewer) void options.sessionCoordinator.refreshActiveSessionUsage(); },
      subagentPathNavigation: options.subagentPathNavigation ? scopedProjectPathNavigation(
        workspace,
        () => options.workspace() === workspace && options.activeSessionId() === sessionId,
        options.subagentPathNavigation,
      ) : undefined,
      onRefreshClaudeLimits: () => { if (!viewer) void options.sessionCoordinator.refreshActiveClaudeLimits(); },
      onClearTodos: () => !viewer && sessionId ? options.clearSessionTodos(sessionId) : Promise.resolve(false),
    };
  });

  return {
    get props() { return props; },
  };
}
