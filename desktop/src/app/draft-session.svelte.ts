import { tick } from "svelte";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";

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
  routeDraftModel: (prompt: string, attachmentCount: number, signal?: AbortSignal) => Promise<DraftModelOverride>;
  switchComposerDraft: (
    sourceOwnerId: string | null | undefined,
    targetOwnerId: string,
    options?: { resetTarget?: boolean; preserveSource?: boolean },
  ) => void;
  forgetComposerDraft: (ownerId: string) => void;
  setPromptText: (text: string) => void;
  replacePromptAttachments: (attachments: readonly Attachment[]) => void;
  focusComposer: () => void | Promise<void>;
  forgetRuntime: (sessionId: string) => void;
  ensureProvisionalSession: (sessionId: string, workspace: string) => void;
  showSessionTab: (sessionId: string) => void;
  retargetWorkbenchAnchors: (sourceSessionId: string, targetSessionId?: string) => void;
  retargetAttachmentDraftKey: (workspace: string, sessionId: string) => void;
  adoptMaterializedTranscript: (sessionId: string) => void;
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
  let materializationController: AbortController | null = null;
  let optimisticComposerSnapshot: { text: string; attachments: Attachment[] } | null = null;

  function beginOptimisticSubmit(text: string, attachments: readonly Attachment[]): boolean {
    if (!active || materializing || optimisticComposerSnapshot) return false;
    optimisticComposerSnapshot = { text, attachments: [...attachments] };
    return true;
  }

  function clearOptimisticSubmit(): void {
    optimisticComposerSnapshot = null;
  }

  function restoreOptimisticSubmit(): void {
    const snapshot = optimisticComposerSnapshot;
    if (!snapshot) return;
    optimisticComposerSnapshot = null;
    options.setPromptText(snapshot.text);
    options.replacePromptAttachments(snapshot.attachments);
  }

  function invalidateMaterialization(): void {
    materializationGeneration += 1;
    materializationController?.abort();
    materializationController = null;
    materializing = false;
  }

  function activate(config: { resetComposer?: boolean } = {}): void {
    if (!options.workspace() || !options.statusReady()) return;
    options.closeProjectSelector();
    options.closeSessionSelector();
    if (config.resetComposer) {
      clearOptimisticSubmit();
      invalidateMaterialization();
    }
    const currentSessionId = options.activeSessionId();
    const sourceOwnerId = active ? DRAFT_SESSION_TAB_ID : currentSessionId;
    if (currentSessionId) options.saveActiveTranscript(currentSessionId);
    options.cancelHistoryLoad();
    options.setActiveSessionId(null);
    options.resetActiveConversation();
    open = true;
    active = true;
    options.switchComposerDraft(sourceOwnerId, DRAFT_SESSION_TAB_ID, { resetTarget: config.resetComposer });
    if (config.resetComposer) {
      touched = false;
      options.resetModelDraft();
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

  async function materialize(prompt?: string, attachmentCount = 0): Promise<string | null> {
    if (!active) return options.activeSessionId();
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady() || options.operationRunning() || materializing) {
      return null;
    }
    const generation = ++materializationGeneration;
    const controller = new AbortController();
    materializationController?.abort();
    materializationController = controller;
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
      const routed = prompt !== undefined
        ? await options.routeDraftModel(prompt, attachmentCount, controller.signal)
        : null;
      if (abandoned() || controller.signal.aborted) return null;
      const created = await requestClient.newSession(
        requestWorkspace,
        routed ?? options.draftModelOverride() ?? undefined,
      );
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
      clearOptimisticSubmit();
      options.forgetComposerDraft(DRAFT_SESSION_TAB_ID);
      options.resetModelDraft();
      options.adoptMaterializedTranscript(created.sessionId);
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
      ) {
        restoreOptimisticSubmit();
        options.reportError(error);
      }
      return null;
    } finally {
      if (generation === materializationGeneration) {
        if (materializationController === controller) materializationController = null;
        materializing = false;
      }
    }
  }

  function deactivate(): void {
    restoreOptimisticSubmit();
    invalidateMaterialization();
    active = false;
  }

  function close(): void {
    clearOptimisticSubmit();
    invalidateMaterialization();
    options.forgetComposerDraft(DRAFT_SESSION_TAB_ID);
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
    beginOptimisticSubmit,
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
