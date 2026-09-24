import type { ComponentProps } from "svelte";
import DesktopStatusBar from "../components/DesktopStatusBar.svelte";
import { projectFolderHue, projectName } from "../lib/recent-projects";
import type { createConversationNavigation } from "./conversation-navigation";
import type { createDcpCompression } from "./dcp-compression.svelte";
import type { createDesktopCommandController } from "./desktop-command-controller.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createSessionCoordinator } from "./session-coordinator";
import type { createSessionInspectorPreference } from "./session-inspector-preference.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import { shouldShowStatusBarSkeletons } from "./status-bar-skeleton";

type StatusBarProps = ComponentProps<typeof DesktopStatusBar>["props"];

export function createDesktopStatusBarViewModel(options: {
  workspace: () => string;
  workspaceBranch: () => string | undefined;
  workspaceColor: () => string | undefined;
  status: () => StatusBarProps["status"];
  displayedConfigOptions: () => StatusBarProps["configOptions"];
  changingConfig: () => string | null;
  promptRunning: () => boolean;
  canUseSession: () => boolean;
  sessionHistoryLoading: () => boolean;
  draftSessionTabActive: () => boolean;
  draftConfigAvailable: () => boolean;
  activeSessionRuntimeReady: () => boolean;
  activeSessionId: () => string | null;
  activeAgentControlState: () => string;
  dcpCompressionAvailable: () => boolean;
  sessionActivity: () => StatusBarProps["sessionActivity"];
  sessionNeedsInput: () => boolean;
  commandPaletteShortcut: () => string | undefined;
  runtime: ReturnType<typeof createSessionRuntimeStore>;
  dcp: ReturnType<typeof createDcpCompression>;
  modelConfig: ReturnType<typeof createModelConfig>;
  sessionCoordinator: ReturnType<typeof createSessionCoordinator>;
  inspectorPreference: ReturnType<typeof createSessionInspectorPreference>;
  navigation: ReturnType<typeof createConversationNavigation>;
  commands: ReturnType<typeof createDesktopCommandController>;
}) {
  const props = $derived.by<StatusBarProps>(() => {
    const sessionId = options.activeSessionId();
    const draft = options.draftSessionTabActive();
    const pickerCommand = options.commands.picker?.command;
    const compressionAvailable = options.dcpCompressionAvailable();
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

    return {
      status: connectionStatus,
      showSkeletons,
      workspacePath: options.workspace() || undefined,
      workspaceName: options.workspace() ? projectName(options.workspace()) : undefined,
      workspaceBranch: options.workspaceBranch(),
      workspaceHue: options.workspace() ? projectFolderHue(options.workspace()) : undefined,
      workspaceColor: options.workspaceColor(),
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
      dcpStatsRefreshing: sessionId ? options.runtime.dcpStatsRefreshing.has(sessionId) : false,
      dcpCompressionRunning: sessionId ? options.dcp.sessionIds.has(sessionId) : false,
      dcpCompressionAvailable: compressionAvailable,
      canCompressContext: compressionAvailable
        && options.canUseSession()
        && !!sessionId
        && runtimeReady
        && changingConfig === null
        && !historyLoading
        && !promptRunning
        && options.activeAgentControlState() === "idle",
      canNavigateMessages: options.canUseSession() && !!sessionId && runtimeReady && !historyLoading,
      messageNavigationOpen: pickerCommand === "jump",
      sessionActivity: options.sessionActivity(),
      sessionActivityOpen: options.inspectorPreference.open,
      canOpenSessionActivity: !!sessionId,
      sessionNeedsInput: options.sessionNeedsInput(),
      commandPaletteOpen: pickerCommand === "commands",
      commandPaletteShortcut: options.commandPaletteShortcut(),
      onSetConfig: (option, value) => void options.modelConfig.setConfig(option, value),
      onOpenModelThinking: options.modelConfig.openPicker,
      onOpenSessionUsage: () => void options.sessionCoordinator.refreshActiveSessionUsage(),
      onOpenDcpStats: () => void options.sessionCoordinator.refreshActiveDcpStats(),
      onCompressDcpContext: () => void options.dcp.compress(),
      onNavigateMessages: () => void options.navigation.openJumpPicker(""),
      onToggleSessionActivity: () => options.inspectorPreference.setOpen(!options.inspectorPreference.open),
      onOpenCommandPalette: () => void options.commands.openPalette(),
    };
  });

  return {
    get props() { return props; },
  };
}
