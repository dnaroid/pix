import type { AcpClient } from "../lib/acp-client";
import {
  registrySnapshotFromSessionState,
  type RegistryActionRequest,
  type RegistrySnapshot,
} from "../lib/registry";
import type { SessionStateNotification } from "../lib/session-state";

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

  function handleSessionState(notification: SessionStateNotification): boolean {
    const next = registrySnapshotFromSessionState(notification);
    if (!next) return false;
    const sourceWorkspace = options.sessionWorkspace(notification.sessionId);
    if (sourceWorkspace && sourceWorkspace !== options.workspace()) return true;
    snapshot = next;
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
      }
    }
  }

  function refresh(): void {
    void runAction({ action: "refresh" }, "refresh");
  }

  function reset(): void {
    snapshot = undefined;
    actionId = null;
  }

  return {
    get snapshot() { return snapshot; },
    get actionId() { return actionId; },
    handleSessionState,
    runAction,
    refresh,
    reset,
  };
}
