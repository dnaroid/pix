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
  reportError: (error: unknown) => void;
};

export function createRegistryStore(options: RegistryStoreOptions) {
  let snapshot = $state<RegistrySnapshot | undefined>(undefined);
  let actionId = $state<string | null>(null);
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

  async function runAction(request: RegistryActionRequest, nextActionId: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
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
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
      if (request.action === "pull-project") {
        const workspace = options.workspace();
        if (request.scope === "tasks" || request.scope === "project") void options.loadProjectTasks(workspace);
        if (request.scope === "plans" || request.scope === "todo" || request.scope === "project") {
          void options.loadProjectDocuments(workspace);
        }
      }
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) {
        actionId = null;
        options.setOperationRunning(false);
        backgroundSync.retry();
      }
    }
  }

  function refresh(): void {
    void runAction({ action: "refresh" }, "refresh");
  }

  function reset(): void {
    snapshot = undefined;
    actionId = null;
    backgroundSync.reset();
  }

  function scheduleProjectSync(scope: RegistryProjectSyncScope): void {
    backgroundSync.mark(scope);
  }

  return {
    get snapshot() { return snapshot; },
    get actionId() { return actionId; },
    get backgroundSyncState() { return backgroundSyncState; },
    handleSessionState,
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
