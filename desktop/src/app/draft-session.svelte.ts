import { tick } from "svelte";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";

export const DRAFT_SESSION_TAB_ID = "pix:desktop-draft-session";

type DraftModelOverride = { modelRef: string; thinkingLevel: string } | null;

type DraftSessionOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  operationRunning: () => boolean;
  canUseSession: () => boolean;
  activeSessionId: () => string | null;
  setActiveSessionId: (sessionId: string | null) => void;
  saveActiveTranscript: (sessionId: string) => void;
  resetActiveConversation: () => void;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  cancelHistoryLoad: () => void;
  resetModelDraft: () => void;
  draftConfigAvailable: () => boolean;
  refreshDraftConfig: () => void | Promise<void>;
  draftModelOverride: () => DraftModelOverride;
  clearPrompt: () => void;
  invalidateAttachmentDraft: () => void;
  focusComposer: () => void | Promise<void>;
  forgetRuntime: (sessionId: string) => void;
  ensureProvisionalSession: (sessionId: string, workspace: string) => void;
  showSessionTab: (sessionId: string) => void;
  retargetWorkbenchAnchors: (sourceSessionId: string, targetSessionId?: string) => void;
  retargetAttachmentDraftKey: (workspace: string, sessionId: string) => void;
  setMaterializedTranscript: (sessionId: string) => void;
  setConfigOptions: (options: SessionConfigOption[]) => void;
  markRuntimeReady: (sessionId: string, options: SessionConfigOption[]) => void;
  rememberActiveSession: (workspace: string, sessionId: string) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDraftSession(options: DraftSessionOptions) {
  let open = $state(false);
  let active = $state(false);
  let touched = $state(false);
  let materializing = $state(false);
  let materializationGeneration = 0;

  function invalidateMaterialization(): void {
    materializationGeneration += 1;
    materializing = false;
  }

  function activate(config: { resetComposer?: boolean } = {}): void {
    if (!options.workspace() || !options.statusReady()) return;
    options.closeProjectSelector();
    options.closeSessionSelector();
    if (config.resetComposer) invalidateMaterialization();
    const currentSessionId = options.activeSessionId();
    if (currentSessionId) options.saveActiveTranscript(currentSessionId);
    options.cancelHistoryLoad();
    options.setActiveSessionId(null);
    options.resetActiveConversation();
    open = true;
    active = true;
    if (config.resetComposer) {
      touched = false;
      options.resetModelDraft();
      options.clearPrompt();
      options.invalidateAttachmentDraft();
    }
    if (!options.draftConfigAvailable()) void options.refreshDraftConfig();
  }

  async function openStartTab(): Promise<void> {
    if (!options.canUseSession()) return;
    if (open) {
      activate();
      await tick();
      await options.focusComposer();
      return;
    }
    activate({ resetComposer: true });
    await tick();
    await options.focusComposer();
  }

  async function materialize(): Promise<string | null> {
    if (!active) return options.activeSessionId();
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady() || options.operationRunning() || materializing) {
      return null;
    }
    const generation = ++materializationGeneration;
    let createdSessionId: string | null = null;
    materializing = true;
    options.setErrorMessage(null);

    const abandoned = (): boolean => (
      requestClient !== options.client()
      || requestWorkspace !== options.workspace()
      || generation !== materializationGeneration
      || !active
    );
    const discardCreatedSession = (sessionId: string): void => {
      options.forgetRuntime(sessionId);
      void requestClient.closeSession(sessionId).catch(() => undefined);
    };

    try {
      const created = await requestClient.newSession(requestWorkspace, options.draftModelOverride() ?? undefined);
      createdSessionId = created.sessionId;
      if (abandoned()) {
        discardCreatedSession(created.sessionId);
        return null;
      }
      const loaded = await requestClient.loadSession(created.sessionId, requestWorkspace);
      if (abandoned()) {
        discardCreatedSession(created.sessionId);
        return null;
      }

      options.ensureProvisionalSession(created.sessionId, requestWorkspace);
      options.showSessionTab(created.sessionId);
      options.retargetWorkbenchAnchors(DRAFT_SESSION_TAB_ID, created.sessionId);
      options.retargetAttachmentDraftKey(requestWorkspace, created.sessionId);
      options.setActiveSessionId(created.sessionId);
      open = false;
      active = false;
      touched = false;
      options.resetModelDraft();
      options.setMaterializedTranscript(created.sessionId);
      const configOptions = loaded.configOptions ?? created.configOptions ?? [];
      options.setConfigOptions(configOptions);
      options.markRuntimeReady(created.sessionId, configOptions);
      options.rememberActiveSession(requestWorkspace, created.sessionId);
      return created.sessionId;
    } catch (error) {
      if (createdSessionId) discardCreatedSession(createdSessionId);
      if (
        requestClient === options.client()
        && requestWorkspace === options.workspace()
        && generation === materializationGeneration
        && active
      ) options.reportError(error);
      return null;
    } finally {
      if (generation === materializationGeneration) materializing = false;
    }
  }

  function deactivate(): void {
    active = false;
  }

  function close(): void {
    invalidateMaterialization();
    open = false;
    active = false;
    touched = false;
  }

  function promote(): void {
    if (active) touched = true;
  }

  function reset(): void {
    close();
  }

  return {
    get open() { return open; },
    get active() { return active; },
    get touched() { return touched; },
    get materializing() { return materializing; },
    invalidateMaterialization,
    activate,
    openStartTab,
    materialize,
    deactivate,
    close,
    promote,
    reset,
  };
}
