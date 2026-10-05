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

type StatusBarProps = ComponentProps<typeof DesktopStatusBar>["props"];

export function createDesktopStatusBarViewModel(options: {
  status: () => StatusBarConnectionStatus;
  displayedConfigOptions: () => StatusBarProps["configOptions"];
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
  sessionBrainstormSnapshot?: () => StatusBarProps["sessionBrainstormSnapshot"];
  sessionNeedsInput: () => boolean;
  canClearTodos: () => boolean;
  clearSessionTodos: (sessionId: string) => Promise<boolean>;
  runtime: ReturnType<typeof createSessionRuntimeStore>;
  modelConfig: ReturnType<typeof createModelConfig>;
  sessionCoordinator: ReturnType<typeof createSessionCoordinator>;
  quotaWait: QuotaWaitStore;
  headsUp: HeadsUpStore;
  openObserverSettings: () => void;
  openBrainstormParticipant?: (sessionId: string) => void;
}) {
  const props = $derived.by<StatusBarProps>(() => {
    const sessionId = options.activeSessionId();
    const draft = options.draftSessionTabActive();
    const runtimeReady = options.activeSessionRuntimeReady();
    const historyLoading = options.sessionHistoryLoading();
    const changingConfig = options.changingConfig();
    const promptRunning = options.promptRunning();
    let runtimeStatus: StatusBarProps["runtimeStatus"];
    if (draft) {
      runtimeStatus = options.modelConfig.draftRuntimeStatus;
    } else if (sessionId) {
      runtimeStatus = options.runtime.statuses.get(sessionId);
    }
    const connectionStatus = options.status();
    const showSkeletons = shouldShowStatusBarSkeletons({
      connectionStatus,
      draft,
      historyLoading,
      sessionId,
      runtimeReady,
      runtimeStatusAvailable: runtimeStatus !== undefined,
    });

    const sessionActivity = options.sessionActivity();
    const waitState = options.quotaWait.indicator(sessionId);
    const nowMs = options.quotaWait.nowMs;
    const observerSnapshot = draft ? undefined : options.headsUp.state(sessionId);
    const observerOwnerCurrent = () => options.activeSessionId() === sessionId
      && !options.draftSessionTabActive() && options.activeSessionRuntimeReady() && options.status() === "ready"
      && (!observerSnapshot || options.headsUp.state(sessionId)?.instanceId === observerSnapshot.instanceId);

    return {
      showSkeletons,
      configOptions: options.displayedConfigOptions(),
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
      canConfigure: options.canUseSession()
        && !historyLoading
        && (draft ? options.draftConfigAvailable() : runtimeReady),
      modelThinkingOpen: options.modelConfig.pickerOpen,
      runtimeStatus,
      sessionUsage: sessionId ? options.runtime.sessionUsageBySession.get(sessionId) : undefined,
      sessionUsageRefreshing: sessionId ? options.runtime.sessionUsageRefreshing.has(sessionId) : false,
      sessionUsageFailed: sessionId ? options.runtime.sessionUsageFailed.has(sessionId) : false,
      sessionUsageAvailable: !!sessionId && runtimeReady,
      // The manual Claude Code limit refresh exists only for a live (non-draft)
      // session whose active model routes through pi-claude-code-provider.
      claudeCodeRoute: !!sessionId
        && !draft
        && modelThinkingConfigState(options.displayedConfigOptions()).currentModel?.provider === "pi-claude-code-provider",
      claudeLimitsRefreshing: sessionId ? options.runtime.claudeLimitsRefreshing.has(sessionId) : false,
      claudeLimitsFailed: sessionId ? options.runtime.claudeLimitsFailed.has(sessionId) : false,
      sessionActivity,
      sessionSubagentSnapshot: options.sessionSubagentSnapshot(),
      sessionTodoSnapshot: options.sessionTodoSnapshot(),
      sessionBrainstormSnapshot: options.sessionBrainstormSnapshot?.(),
      onOpenBrainstormParticipant: options.openBrainstormParticipant,
      sessionNeedsInput: options.sessionNeedsInput(),
      canClearTodos: options.canClearTodos(),
      onSetConfig: (option, value) => void options.modelConfig.setConfig(option, value),
      onOpenModelThinking: options.modelConfig.openPicker,
      onOpenSessionUsage: () => void options.sessionCoordinator.refreshActiveSessionUsage(),
      onRefreshClaudeLimits: () => void options.sessionCoordinator.refreshActiveClaudeLimits(),
      onClearTodos: () => sessionId ? options.clearSessionTodos(sessionId) : Promise.resolve(false),
    };
  });

  return {
    get props() { return props; },
  };
}
