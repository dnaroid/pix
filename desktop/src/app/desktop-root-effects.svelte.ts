import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { modelThinkingConfigState } from "../lib/model-thinking";
import {
  createSessionInspectorActivityTracker,
  syncSessionInspectorActivity,
} from "../lib/session-inspector-activity-policy";
import type { SessionSubagentSnapshot } from "../lib/session-subagents";
import type { SessionTodoSnapshot } from "../lib/session-todos";
import {
  normalizeWorkbenchTab,
  workbenchSessionId,
  type WorkbenchTab,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";

type DesktopRootEffectsOptions = {
  statusReady: () => boolean;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  configOptions: () => SessionConfigOption[];
  refreshRuntimeStatus: (sessionId: string, force: boolean) => void | Promise<void>;
  attachmentDraftKey: () => string;
  workspace: () => string;
  invalidateAttachmentDraft: () => void;
  invalidatePreviewFileLoads: () => void;
  resetPreviewForWorkspaceChange: () => void;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  workbenchTabs: () => readonly WorkbenchTab[];
  activeTodoSnapshot: () => SessionTodoSnapshot | undefined;
  activeSubagentSnapshot: () => SessionSubagentSnapshot | undefined;
  sessionInspectorOpen: () => boolean;
  setSessionInspectorOpen: (open: boolean) => void;
  markSessionTabViewed: (sessionId: string) => void;
};

export function createDesktopRootEffects(options: DesktopRootEffectsOptions) {
  let runtimeStatusActivationKey = "";
  let previousAttachmentDraftKey: string | null = null;
  let previousPreviewWorkspace: string | null = null;
  let previousConversationWorkbenchTabId: WorkbenchTabId | null = null;
  const inspectorActivityTracker = createSessionInspectorActivityTracker();

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
    if (previousAttachmentDraftKey !== null && previousAttachmentDraftKey !== key) {
      options.invalidateAttachmentDraft();
      options.invalidatePreviewFileLoads();
    }
    previousAttachmentDraftKey = key;

    const currentWorkspace = options.workspace();
    if (previousPreviewWorkspace !== null && previousPreviewWorkspace !== currentWorkspace) {
      options.resetPreviewForWorkspaceChange();
    }
    previousPreviewWorkspace = currentWorkspace;
  });

  $effect(() => {
    syncSessionInspectorActivity(
      inspectorActivityTracker,
      options.activeSessionId(),
      options.activeTodoSnapshot(),
      options.activeSubagentSnapshot(),
      options.sessionInspectorOpen(),
      options.setSessionInspectorOpen,
    );
  });

  $effect(() => {
    const conversationTabId = options.activeConversationWorkbenchTabId();
    if (conversationTabId !== previousConversationWorkbenchTabId) {
      if (conversationTabId) options.setActiveWorkbenchTabId(conversationTabId);
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
      previousAttachmentDraftKey = `${workspace}\0${sessionId}`;
    },
    resetWorkbenchTracking(): void {
      previousConversationWorkbenchTabId = null;
    },
  };
}

export type DesktopRootEffects = ReturnType<typeof createDesktopRootEffects>;
