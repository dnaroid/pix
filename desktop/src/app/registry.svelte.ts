import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "../lib/acp-client";
import {
  registrySnapshotFromSessionState,
  type RegistryActionRequest,
  type RegistrySnapshot,
} from "../lib/registry";
import type { SessionStateNotification } from "../lib/session-state";
import {
  RegistryBackgroundSyncCoordinator,
  type RegistryBackgroundSyncState,
  type RegistryProjectSyncScope,
} from "../lib/registry-background-sync";

type RegistryStoreOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  sessionRuntimeReady: () => boolean;
  operationRunning: () => boolean;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  workspace: () => string;
  sessionWorkspace: (sessionId: string) => string | undefined;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  loadProjectTasks: (workspace: string) => void | Promise<void>;
  loadProjectDocuments: (workspace: string) => void | Promise<void>;
  loadWorkspaceSettings?: (workspace: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
};

export function createRegistryStore(options: RegistryStoreOptions) {
  let snapshot = $state<RegistrySnapshot | undefined>(undefined);
  let projectInitialized = $state<boolean | undefined>(undefined);
  let actionId = $state<string | null>(null);
  let projectStateLoadGeneration = 0;
  let lifecycleGeneration = 0;
  let backgroundSyncState = $state<RegistryBackgroundSyncState>({
    phase: "idle",
    dirtyScopes: [],
  });

  const backgroundSync = new RegistryBackgroundSyncCoordinator({
    canSync: () => Boolean(
      snapshot?.configured
      && options.client()
      && options.activeSessionId()
      && options.sessionRuntimeReady()
      && !options.operationRunning()
      && !options.promptRunning()
      && !options.sessionHistoryLoading()
      && actionId === null
    ),
    sync: async (scope) => {
      const requestClient = options.client();
      const sessionId = options.activeSessionId();
      if (!requestClient || !sessionId) throw new Error("Registry background sync has no active session.");
      await requestClient.registryAction(sessionId, { action: "push-project", scope });
    },
    onChange: (state) => { backgroundSyncState = state; },
    shouldRetryError: registryActionBusyError,
  });

  function handleSessionState(notification: SessionStateNotification): boolean {
    const next = registrySnapshotFromSessionState(notification);
    if (!next) return false;
    const sourceWorkspace = options.sessionWorkspace(notification.sessionId);
    if (sourceWorkspace && sourceWorkspace !== options.workspace()) return true;
    snapshot = next;
    if (next.configured) backgroundSync.retry();
    else backgroundSync.reset();
    return true;
  }

  async function refreshProjectInitialization(): Promise<void> {
    const workspace = options.workspace();
    const requestGeneration = ++projectStateLoadGeneration;
    if (!workspace) {
      projectInitialized = undefined;
      return;
    }
    try {
      const initialized = await invoke<boolean>("project_pi_initialized", { workspace });
      if (requestGeneration !== projectStateLoadGeneration || options.workspace() !== workspace) return;
      projectInitialized = initialized;
    } catch (error) {
      if (requestGeneration === projectStateLoadGeneration && options.workspace() === workspace) options.reportError(error);
    }
  }

  async function initializeProject(): Promise<boolean> {
    const workspace = options.workspace();
    const requestGeneration = lifecycleGeneration;
    const current = () => requestGeneration === lifecycleGeneration && options.workspace() === workspace;
    if (!workspace || actionId !== null || backgroundSyncState.phase === "syncing") return false;

    actionId = "initialize-project";
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    let initialized = false;
    try {
      await invoke("initialize_project_pi", { workspace });
      if (!current()) return false;
      projectInitialized = true;
      await Promise.all([
        Promise.resolve(options.loadProjectTasks(workspace)),
        Promise.resolve(options.loadProjectDocuments(workspace)),
      ]);
      initialized = current();
      return initialized;
    } catch (error) {
      if (current()) options.reportError(error);
      return false;
    } finally {
      if (current()) {
        actionId = null;
        options.setOperationRunning(false);
        backgroundSync.retry();
        if (initialized) refresh();
      }
    }
  }

  async function runAction(request: RegistryActionRequest, nextActionId: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const workspace = options.workspace();
    const requestGeneration = lifecycleGeneration;
    const current = () => requestGeneration === lifecycleGeneration
      && workspace === options.workspace()
      && requestClient === options.client()
      && sessionId === options.activeSessionId();
    if (
      !requestClient
      || !sessionId
      || !options.sessionRuntimeReady()
      || options.operationRunning()
      || options.promptRunning()
      || options.sessionHistoryLoading()
      || actionId !== null
      || backgroundSyncState.phase === "syncing"
    ) return;

    actionId = nextActionId;
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      await requestClient.registryAction(sessionId, request);
      if (!current()) return;
      if (request.action === "pull-project") {
        if (request.scope === "workspace" || request.scope === "project") void options.loadWorkspaceSettings?.(workspace);
        if (request.scope === "tasks" || request.scope === "project") void options.loadProjectTasks(workspace);
        if (request.scope === "plans" || request.scope === "todo" || request.scope === "project") {
          void options.loadProjectDocuments(workspace);
        }
      }
    } catch (error) {
      if (current()) options.reportError(error);
    } finally {
      if (current()) {
        actionId = null;
        options.setOperationRunning(false);
        backgroundSync.retry();
      }
    }
  }

  function refresh(): void {
    void refreshProjectInitialization();
    void runAction({ action: "refresh" }, "refresh");
  }

  function reset(): void {
    lifecycleGeneration += 1;
    projectStateLoadGeneration += 1;
    snapshot = undefined;
    projectInitialized = undefined;
    actionId = null;
    backgroundSync.reset();
  }

  function scheduleProjectSync(scope: RegistryProjectSyncScope): void {
    backgroundSync.mark(scope);
  }

  return {
    get snapshot() { return snapshot; },
    get projectInitialized() { return projectInitialized; },
    get actionId() { return actionId; },
    get backgroundSyncState() { return backgroundSyncState; },
    handleSessionState,
    refreshProjectInitialization,
    initializeProject,
    runAction,
    refresh,
    scheduleProjectSync,
    reset,
  };
}

function registryActionBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("registry actions are unavailable while the agent is running")
    || message.includes("registry actions are unavailable while the session is busy");
}
