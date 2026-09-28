import type { ComponentProps } from "svelte";
import DesktopStatusBar from "../components/DesktopStatusBar.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createSessionCoordinator } from "./session-coordinator";
import type { createSessionInspectorPreference } from "./session-inspector-preference.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import { shouldShowStatusBarSkeletons, type StatusBarConnectionStatus } from "./status-bar-skeleton";
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
  sessionNeedsInput: () => boolean;
  canClearTodos: () => boolean;
  clearSessionTodos: (sessionId: string) => Promise<boolean>;
  runtime: ReturnType<typeof createSessionRuntimeStore>;
  modelConfig: ReturnType<typeof createModelConfig>;
  sessionCoordinator: ReturnType<typeof createSessionCoordinator>;
  inspectorPreference: ReturnType<typeof createSessionInspectorPreference>;
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

    return {
      showSkeletons,
      configOptions: options.displayedConfigOptions(),
      changingConfig,
      promptRunning,
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
      sessionActivityOpen: options.inspectorPreference.open,
      sessionNeedsInput: options.sessionNeedsInput(),
      canClearTodos: options.canClearTodos(),
      onSetConfig: (option, value) => void options.modelConfig.setConfig(option, value),
      onOpenModelThinking: options.modelConfig.openPicker,
      onOpenSessionUsage: () => void options.sessionCoordinator.refreshActiveSessionUsage(),
      onRefreshClaudeLimits: () => void options.sessionCoordinator.refreshActiveClaudeLimits(),
      onClearTodos: () => sessionId ? options.clearSessionTodos(sessionId) : Promise.resolve(false),
      onOpenSessionActivity: () => options.inspectorPreference.setOpen(true),
    };
  });

  return {
    get props() { return props; },
  };
}
