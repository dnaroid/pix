import type { DesktopShortcutPlatform } from "../lib/desktop-commands";
import type { WorkbenchTab, WorkbenchTabId } from "../lib/workbench-tabs";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { createDesktopCommandController } from "./desktop-command-controller.svelte";
import type { DesktopConversationServices } from "./desktop-conversation-services";
import type { DesktopModelServices } from "./desktop-model-services";

type DraftSessionRef = {
  active: boolean;
  openStartTab: () => void | Promise<void>;
};

type SessionTabsRef = {
  closeSessionSelector: () => void;
};

type WorkbenchControllerRef = {
  select: (id: WorkbenchTabId) => void;
  close: (id: WorkbenchTabId, fallbackId: WorkbenchTabId | null) => Promise<boolean>;
};

type DesktopCommandServicesOptions = {
  platform: DesktopShortcutPlatform;
  activeFormElicitation: () => boolean;
  anyPromptRunning: () => boolean;
  sessionMutationRunning: () => boolean;
  tasksSaving: () => boolean;
  taskActionId: () => string | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeWorkbenchTabKind: () => "session" | "preview" | "diff" | "lsp-install" | "terminal" | undefined;
  workbenchTabs: () => readonly WorkbenchTab[];
  previewOpen: () => boolean;
  gitDiffOpen: () => boolean;
  canUseSession: () => boolean;
  statusReady: () => boolean;
  workspace: () => string;
  clientAvailable: () => boolean;
  state: ActiveSessionState;
  draftSession: () => DraftSessionRef;
  changingConfig: () => string | null;
  sessionInspectorOpen: () => boolean;
  sessionSelectorOpen: () => boolean;
  closeProjectSelector: () => void;
  sessionTabs: () => SessionTabsRef;
  model: DesktopModelServices;
  chooseWorkspace: () => void | Promise<void>;
  workbenchController: () => WorkbenchControllerRef;
  conversation: DesktopConversationServices;
  setSessionInspectorOpen: (open: boolean) => void;
  focusComposer: () => void | Promise<void>;
  setPromptText: (text: string) => void;
};

export function createDesktopCommandServices(options: DesktopCommandServicesOptions) {
  const controller = createDesktopCommandController({
    platform: options.platform,
    activeFormElicitation: options.activeFormElicitation,
    anyPromptRunning: options.anyPromptRunning,
    sessionMutationRunning: options.sessionMutationRunning,
    tasksSaving: options.tasksSaving,
    taskActionId: options.taskActionId,
    activeConversationWorkbenchTabId: options.activeConversationWorkbenchTabId,
    activeWorkbenchTabId: options.activeWorkbenchTabId,
    activeWorkbenchTabKind: options.activeWorkbenchTabKind,
    workbenchTabs: options.workbenchTabs,
    previewOpen: options.previewOpen,
    gitDiffOpen: options.gitDiffOpen,
    canUseSession: options.canUseSession,
    statusReady: options.statusReady,
    workspace: options.workspace,
    clientAvailable: options.clientAvailable,
    activeSessionId: () => options.state.sessionId,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    draftSessionTabActive: () => options.draftSession().active,
    draftConfigAvailable: () => options.model.config.draftConfigOptions.length > 0,
    changingConfig: options.changingConfig,
    sessionInspectorOpen: options.sessionInspectorOpen,
    modelThinkingPickerOpen: () => options.model.config.pickerOpen,
    sessionSelectorOpen: options.sessionSelectorOpen,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: () => options.sessionTabs().closeSessionSelector(),
    closeModelThinkingPicker: options.model.config.closePicker,
    chooseWorkspace: options.chooseWorkspace,
    selectWorkbenchTab: (id) => options.workbenchController().select(id),
    closeWorkbenchTab: (id, fallbackId) => options.workbenchController().close(id, fallbackId),
    openSessionStartTab: () => options.draftSession().openStartTab(),
    openJumpPicker: options.conversation.navigation.openJumpPicker,
    openHistoryPicker: options.conversation.navigation.openHistoryPicker,
    setSessionInspectorOpen: options.setSessionInspectorOpen,
    openModelThinkingPicker: options.model.config.openPicker,
    focusComposer: options.focusComposer,
    jumpToUserMessage: options.conversation.navigation.jumpToUserMessage,
    setPromptText: options.setPromptText,
    applyModelSlashCommand: options.model.config.applyModelSlashCommand,
    applyThinkingSlashCommand: options.model.config.applyThinkingSlashCommand,
  });

  return { controller };
}

export type DesktopCommandServices = ReturnType<typeof createDesktopCommandServices>;
