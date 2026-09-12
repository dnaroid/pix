import type { ComponentProps } from "svelte";
import DesktopStatusBar from "../components/DesktopStatusBar.svelte";
import type { createConversationNavigation } from "./conversation-navigation";
import type { createDcpCompression } from "./dcp-compression.svelte";
import type { createDesktopCommandController } from "./desktop-command-controller.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createSessionCoordinator } from "./session-coordinator";
import type { createSessionInspectorPreference } from "./session-inspector-preference.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";

type StatusBarProps = ComponentProps<typeof DesktopStatusBar>["props"];

export function createDesktopStatusBarViewModel(options: {
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

    return {
      status: options.status(),
      configOptions: options.displayedConfigOptions(),
      changingConfig,
      promptRunning,
      canConfigure: options.canUseSession()
        && !historyLoading
        && (draft ? options.draftConfigAvailable() : runtimeReady),
      modelThinkingOpen: options.modelConfig.pickerOpen,
      runtimeStatus: sessionId ? options.runtime.statuses.get(sessionId) : undefined,
      modelUsageRefreshing: sessionId ? options.runtime.modelUsageRefreshing.has(sessionId) : false,
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
      onRefreshModelUsage: options.sessionCoordinator.refreshActiveModelUsage,
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
