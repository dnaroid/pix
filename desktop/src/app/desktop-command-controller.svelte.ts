import { tick } from "svelte";
import type { CommandPickerState } from "../lib/command-interactions";
import {
  COMMAND_PALETTE_IDS,
  desktopCommandDefinition,
  isDesktopCommandId,
  matchesDesktopShortcut,
  type DesktopCommandId,
  type DesktopShortcutPlatform,
} from "../lib/desktop-commands";
import { desktopCommandPickerState } from "../lib/command-interactions";
import {
  workbenchTabCloseFallback,
  type WorkbenchTab,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";

type DesktopCommandControllerOptions = {
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
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  draftSessionTabActive: () => boolean;
  draftConfigAvailable: () => boolean;
  changingConfig: () => string | null;
  sessionInspectorOpen: () => boolean;
  modelThinkingPickerOpen: () => boolean;
  sessionSelectorOpen: () => boolean;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  closeModelThinkingPicker: () => void;
  chooseWorkspace: () => void | Promise<void>;
  selectWorkbenchTab: (id: WorkbenchTabId) => void;
  closeWorkbenchTab: (id: WorkbenchTabId, fallbackId: WorkbenchTabId | null) => Promise<boolean>;
  openSessionStartTab: () => void | Promise<void>;
  openJumpPicker: (query: string) => void | Promise<void>;
  openHistoryPicker: (query: string) => void | Promise<void>;
  setSessionInspectorOpen: (open: boolean) => void;
  openModelThinkingPicker: () => void | Promise<void>;
  focusComposer: () => void | Promise<void>;
  jumpToUserMessage: (entryId: string) => void | Promise<void>;
  setPromptText: (text: string) => void;
  applyModelSlashCommand: (value: string) => void | Promise<void>;
  applyThinkingSlashCommand: (value: string) => void | Promise<void>;
};

export function createDesktopCommandController(options: DesktopCommandControllerOptions) {
  let picker = $state<CommandPickerState | null>(null);

  function setPicker(next: CommandPickerState | null): void {
    picker = next;
  }

  function enabled(id: DesktopCommandId): boolean {
    switch (id) {
      case "application.commandPalette":
        return !options.activeFormElicitation();
      case "workspace.choose":
        return !options.anyPromptRunning()
          && !options.sessionMutationRunning()
          && !options.tasksSaving()
          && options.taskActionId() === null;
      case "editor.conversation":
        return !!options.activeConversationWorkbenchTabId() && options.activeWorkbenchTabKind() !== "session";
      case "editor.preview":
        return options.previewOpen() && options.activeWorkbenchTabId() !== "preview";
      case "editor.gitDiff":
        return options.gitDiffOpen() && options.activeWorkbenchTabId() !== "git-diff";
      case "editor.close":
        return options.activeWorkbenchTabKind() === "preview"
          || options.activeWorkbenchTabKind() === "diff"
          || options.activeWorkbenchTabKind() === "lsp-install"
          || options.activeWorkbenchTabKind() === "terminal";
      case "session.new":
        return options.canUseSession();
      case "session.open":
        return options.statusReady() && !!options.workspace() && !options.sessionMutationRunning();
      case "session.jump":
      case "session.history":
        return options.clientAvailable()
          && !!options.activeSessionId()
          && options.activeSessionRuntimeReady()
          && !options.sessionMutationRunning();
      case "session.activity":
        return !!options.activeSessionId();
      case "session.modelThinking":
        return (options.draftSessionTabActive()
          ? options.draftConfigAvailable()
          : !!options.activeSessionId() && options.activeSessionRuntimeReady())
          && !options.sessionMutationRunning()
          && options.changingConfig() === null;
      case "composer.focus":
        return options.draftSessionTabActive() || !!options.activeSessionId();
      case "composer.enhance":
      case "composer.createTask":
      case "composer.defer":
      case "message.copy":
      case "message.fork":
      case "message.forkNewTab":
      case "message.undo":
        return false;
    }
    return false;
  }

  async function openPalette(): Promise<void> {
    if (!enabled("application.commandPalette")) return;
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.closeModelThinkingPicker();
    if (picker && picker.command !== "commands") {
      picker = null;
      await tick();
    }
    const commands = COMMAND_PALETTE_IDS
      .filter((id) => enabled(id))
      .map((id) => desktopCommandDefinition(id));
    picker = desktopCommandPickerState(commands, options.platform);
  }

  async function execute(id: DesktopCommandId): Promise<void> {
    if (!enabled(id)) return;
    switch (id) {
      case "application.commandPalette":
        await openPalette();
        return;
      case "workspace.choose":
        await options.chooseWorkspace();
        return;
      case "editor.conversation": {
        const id = options.activeConversationWorkbenchTabId();
        if (id) options.selectWorkbenchTab(id);
        return;
      }
      case "editor.preview":
        options.selectWorkbenchTab("preview");
        return;
      case "editor.gitDiff":
        options.selectWorkbenchTab("git-diff");
        return;
      case "editor.close": {
        const activeId = options.activeWorkbenchTabId();
        if (!activeId) return;
        const fallbackId = workbenchTabCloseFallback(options.workbenchTabs(), activeId);
        await options.closeWorkbenchTab(activeId, fallbackId);
        return;
      }
      case "session.new":
      case "session.open":
        await options.openSessionStartTab();
        return;
      case "session.jump":
        await options.openJumpPicker("");
        return;
      case "session.history":
        await options.openHistoryPicker("");
        return;
      case "session.activity":
        options.setSessionInspectorOpen(!options.sessionInspectorOpen());
        return;
      case "session.modelThinking":
        await options.openModelThinkingPicker();
        return;
      case "composer.focus": {
        const id = options.activeConversationWorkbenchTabId();
        if (id) {
          options.selectWorkbenchTab(id);
          await tick();
        }
        await options.focusComposer();
        return;
      }
      case "composer.enhance":
      case "composer.createTask":
      case "composer.defer":
      case "message.copy":
      case "message.fork":
      case "message.forkNewTab":
      case "message.undo":
        return;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const paletteCommand = desktopCommandDefinition("application.commandPalette");
    if (matchesDesktopShortcut(event, paletteCommand.shortcut, options.platform)) {
      event.preventDefault();
      if (picker?.command === "commands") {
        picker = null;
        return;
      }
      void openPalette();
      return;
    }

    const newSessionCommand = desktopCommandDefinition("session.new");
    if (!matchesDesktopShortcut(event, newSessionCommand.shortcut, options.platform)) return;
    if (!enabled("session.new") || picker || options.modelThinkingPickerOpen() || options.sessionSelectorOpen()) return;
    event.preventDefault();
    void execute("session.new");
  }

  async function selectOption(value: string): Promise<void> {
    const current = picker;
    if (!current) return;
    picker = null;
    if (current.command === "commands") {
      if (!isDesktopCommandId(value)) return;
      await tick();
      await execute(value);
      return;
    }
    if (current.command === "history") {
      options.setPromptText(value);
      return;
    }
    if (current.command === "jump") {
      await options.jumpToUserMessage(value);
      return;
    }
    if (current.command === "model") {
      await options.applyModelSlashCommand(value);
      return;
    }
    if (current.command === "thinking") {
      await options.applyThinkingSlashCommand(value);
    }
  }

  return {
    get picker() { return picker; },
    setPicker,
    enabled,
    openPalette,
    execute,
    handleKeydown,
    selectOption,
  };
}
