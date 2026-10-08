import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { untrack } from "svelte";
import { modelThinkingConfigState } from "../lib/model-thinking";
import { createAttachmentDraftOwnership } from "./attachment-draft-ownership";
import { createRegistryStartupLoader, type RegistryStartupState } from "./registry-startup";
import {
  normalizeWorkbenchTab,
  workbenchSessionId,
  type WorkbenchTab,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";

type DesktopRootEffectsOptions = {
  statusReady: () => boolean;
  registryStartupState: () => RegistryStartupState;
  refreshRegistry: () => void;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  configOptions: () => SessionConfigOption[];
  refreshRuntimeStatus: (sessionId: string, force: boolean) => void | Promise<void>;
  attachmentDraftKey: () => string;
  workspace: () => string;
  invalidateAttachmentDraft: () => void;
  bumpAttachmentGeneration: () => void;
  invalidatePreviewFileLoads: () => void;
  resetPreviewForWorkspaceChange: () => void;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  workbenchTabs: () => readonly WorkbenchTab[];
  markSessionTabViewed: (sessionId: string) => void;
};

export function shouldActivateConversationTab(activeTab: WorkbenchTab | undefined): boolean {
  return !activeTab || activeTab.kind === "session";
}

export function createDesktopRootEffects(options: DesktopRootEffectsOptions) {
  const registryStartup = createRegistryStartupLoader({
    state: options.registryStartupState,
    refresh: options.refreshRegistry,
  });
  $effect(() => registryStartup.sync());
  $effect(() => () => registryStartup.dispose());
  let runtimeStatusActivationKey = "";
  const attachmentOwnership = createAttachmentDraftOwnership({
    invalidate: options.invalidateAttachmentDraft,
    bumpGeneration: options.bumpAttachmentGeneration,
  });
  let previousPreviewWorkspace: string | null = null;
  let previousConversationWorkbenchTabId: WorkbenchTabId | null = null;

  $effect(() => {
    const sessionId = options.activeSessionId();
    const modelThinking = modelThinkingConfigState(options.configOptions());
    const currentModel = modelThinking.currentModel?.ref ?? "";
    const currentThinking = modelThinking.currentThinking;
    if (!options.statusReady() || !sessionId || !options.activeSessionRuntimeReady()) {
      runtimeStatusActivationKey = "";
      return;
    }
    const key = `${sessionId}\0${currentModel}\0${currentThinking}`;
    if (runtimeStatusActivationKey === key) return;
    runtimeStatusActivationKey = key;
    queueMicrotask(() => void options.refreshRuntimeStatus(sessionId, true));
  });

  $effect(() => {
    const key = options.attachmentDraftKey();
    const currentWorkspace = options.workspace();
    if (attachmentOwnership.sync(key, currentWorkspace)) {
      options.invalidatePreviewFileLoads();
    }

    if (previousPreviewWorkspace !== null && previousPreviewWorkspace !== currentWorkspace) {
      options.resetPreviewForWorkspaceChange();
    }
    previousPreviewWorkspace = currentWorkspace;
  });

  $effect(() => {
    const conversationTabId = options.activeConversationWorkbenchTabId();
    if (conversationTabId !== previousConversationWorkbenchTabId) {
      const activeTab = untrack(() => options.workbenchTabs().find(
        (tab) => tab.id === options.activeWorkbenchTabId(),
      ));
      // An auxiliary surface can own focus while close changes the conversation.
      if (conversationTabId && shouldActivateConversationTab(activeTab)) {
        options.setActiveWorkbenchTabId(conversationTabId);
      }
      previousConversationWorkbenchTabId = conversationTabId;
    }
  });

  $effect(() => {
    const normalized = normalizeWorkbenchTab(
      options.activeWorkbenchTabId(),
      options.workbenchTabs(),
      options.activeConversationWorkbenchTabId(),
    );
    if (normalized !== options.activeWorkbenchTabId()) options.setActiveWorkbenchTabId(normalized);
  });

  $effect(() => {
    const sessionId = workbenchSessionId(options.activeWorkbenchTabId());
    if (sessionId) options.markSessionTabViewed(sessionId);
  });

  return {
    retargetAttachmentDraftKey(workspace: string, sessionId: string): void {
      attachmentOwnership.retarget(workspace, sessionId);
    },
    resetWorkbenchTracking(): void {
      previousConversationWorkbenchTabId = null;
    },
  };
}

export type DesktopRootEffects = ReturnType<typeof createDesktopRootEffects>;
