import type { AcpClient } from "../lib/acp-client";
import {
  registryDiffAvailable,
  registrySnapshotFromSessionState,
  type RegistryActionRequest,
  type RegistryDiffState,
  type RegistryItem,
  type RegistrySnapshot,
} from "../lib/registry";
import type { SessionStateNotification } from "../lib/session-state";
import {
  RegistryBackgroundSyncCoordinator,
  type RegistryBackgroundSyncState,
  type RegistryProjectSyncScope,
} from "../lib/registry-background-sync";
import { createRegistryProjectStorage } from "./registry-project-storage.svelte";

type RegistryStoreOptions = {
  client: () => AcpClient | null;
  operationRunning: () => boolean;
  workspace: () => string;
  sessionWorkspace: (sessionId: string) => string | undefined;
  setErrorMessage: (message: string | null) => void;
  loadProjectTasks: (workspace: string) => void | Promise<void>;
  loadProjectDocuments: (workspace: string) => void | Promise<void>;
  loadWorkspaceSettings?: (workspace: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
};

export function createRegistryStore(options: RegistryStoreOptions) {
  let snapshot = $state<RegistrySnapshot | undefined>(undefined);
  let actionId = $state<string | null>(null);
  let diff = $state<RegistryDiffState | undefined>(undefined);
  let diffGeneration = 0;
  let lifecycleGeneration = 0;
  let backgroundSyncState = $state<RegistryBackgroundSyncState>({
    phase: "idle",
    dirtyScopes: [],
  });

  const backgroundSync = new RegistryBackgroundSyncCoordinator({
    canSync: () => Boolean(
      snapshot?.configured
      && options.client()
      && options.workspace()
      && !options.operationRunning()
      && actionId === null
    ),
    sync: async (scope) => {
      const requestClient = options.client();
      const workspace = options.workspace();
      const requestGeneration = lifecycleGeneration;
      if (!requestClient || !workspace) throw new Error("Registry background sync has no active workspace.");
      const next = await requestClient.registryAction(workspace, { action: "sync-project", scope });
      if (
        requestGeneration === lifecycleGeneration
        && options.workspace() === workspace
        && options.client() === requestClient
      ) {
        snapshot = next;
        if (next.error) throw new Error(next.error);
      }
    },
    onChange: (state) => { backgroundSyncState = state; },
    shouldRetryError: registryActionBusyError,
  });

  // Project-local disk housekeeping: independent of registry sync, but shares
  // the panel's action mutex so init/clean cannot overlap a registry action.
  const storage = createRegistryProjectStorage({
    workspace: options.workspace,
    busy: () => options.operationRunning() || actionId !== null || backgroundSyncState.phase === "syncing",
    setActionId: (next) => { actionId = next; },
    setErrorMessage: options.setErrorMessage,
    loadProjectTasks: options.loadProjectTasks,
    loadProjectDocuments: options.loadProjectDocuments,
    reportError: options.reportError,
    onChanged: () => { seedProjectSync(); backgroundSync.retry(); },
  });

  function handleSessionState(notification: SessionStateNotification): boolean {
    const next = registrySnapshotFromSessionState(notification);
    if (!next) return false;
    const sourceWorkspace = options.sessionWorkspace(notification.sessionId);
    if (sourceWorkspace && sourceWorkspace !== options.workspace()) return true;
    snapshot = next;
    seedProjectSync();
    return true;
  }

  function reloadLocalProjectState(scope: RegistryProjectSyncScope, workspace: string): void {
    if (scope === "workspace" || scope === "project") void options.loadWorkspaceSettings?.(workspace);
    if (scope === "tasks" || scope === "project") void options.loadProjectTasks(workspace);
    if (scope === "plans" || scope === "todo" || scope === "project") {
      void options.loadProjectDocuments(workspace);
    }
  }

  async function runAction(request: RegistryActionRequest, nextActionId: string): Promise<void> {
    const requestClient = options.client();
    const workspace = options.workspace();
    const requestGeneration = lifecycleGeneration;
    const current = () => requestGeneration === lifecycleGeneration
      && workspace === options.workspace()
      && requestClient === options.client();
    if (
      !requestClient
      || !workspace
      || options.operationRunning()
      || actionId !== null
      || backgroundSyncState.phase === "syncing"
    ) return;

    actionId = nextActionId;
    // Registry RPC uses the standalone workspace-scoped ACP service.
    // Keep exclusivity local to Registry; the global Desktop operation lock
    // would unnecessarily disable unrelated workbench UI while Git is running.
    options.setErrorMessage(null);
    try {
      const next = await requestClient.registryAction(workspace, request);
      if (!current()) return;
      snapshot = next;
      if (request.action === "pull-project") reloadLocalProjectState(request.scope, workspace);
    } catch (error) {
      if (current()) options.reportError(error);
    } finally {
      if (current()) {
        actionId = null;
        backgroundSync.retry();
      }
    }
  }

  /**
   * On-demand read-only comparison of one resource's registry and local
   * copies. Diff is independent of mutating registry actions, but a late
   * response must never replace a newer selection, workspace or closed view.
   */
  function openDiff(item: RegistryItem): void {
    if (item.type === "project" || !registryDiffAvailable(item)) return;
    const target = { type: item.type, name: item.name };
    const requestClient = options.client();
    const workspace = options.workspace();
    const requestDiffGeneration = ++diffGeneration;
    const requestLifecycleGeneration = lifecycleGeneration;
    const current = () => requestDiffGeneration === diffGeneration
      && requestLifecycleGeneration === lifecycleGeneration
      && workspace === options.workspace()
      && requestClient === options.client();
    if (!requestClient || !workspace) {
      diff = { phase: "error", target, error: "Registry diff needs an active workspace connection." };
      return;
    }
    diff = { phase: "loading", target };
    void (async () => {
      try {
        const result = await requestClient.registryDiff(workspace, target.type, target.name);
        if (!current()) return;
        diff = { phase: "ready", target, files: result.files };
      } catch (error) {
        if (!current()) return;
        diff = {
          phase: "error",
          target,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
  }

  function closeDiff(): void {
    diffGeneration += 1;
    diff = undefined;
  }

  function refresh(): void {
    void storage.refresh();
    void runAction({ action: "refresh" }, "refresh");
  }

  function observeProjectChange(scope: RegistryProjectSyncScope): void {
    const workspace = options.workspace();
    if (!workspace) return;
    reloadLocalProjectState(scope, workspace);
    backgroundSync.observe(scope);
  }

  function seedProjectSync(): void {
    if (!snapshot?.configured) {
      backgroundSync.reset();
      return;
    }
    if (backgroundSyncState.phase === "syncing" || backgroundSyncState.phase === "error") return;
    for (const item of snapshot.items) {
      if (item.type !== "project" && item.local && item.status === "local-only") {
        backgroundSync.observe("project");
      }
      if (item.type === "project" && item.artifact && item.local
        && (item.status === "local-only" || item.status === "local-changes")) {
        backgroundSync.observe(item.artifact);
      }
    }
  }

  function reset(): void {
    lifecycleGeneration += 1;
    diffGeneration += 1;
    snapshot = undefined;
    actionId = null;
    diff = undefined;
    backgroundSync.reset();
    storage.reset();
  }

  function scheduleProjectSync(scope: RegistryProjectSyncScope): void {
    backgroundSync.mark(scope);
  }

  return {
    get snapshot() { return snapshot; },
    get projectInitialized() { return storage.initialized; },
    get projectPiSizeBytes() { return storage.sizeBytes; },
    get projectPiCleanupBytes() { return storage.cleanupBytes; },
    get projectPiCleanupAvailable() { return storage.cleanupAvailable; },
    get projectPiStorageLoading() { return storage.loading; },
    get projectPiStorageError() { return storage.error; },
    get actionId() { return actionId; },
    get backgroundSyncState() { return backgroundSyncState; },
    get diff() { return diff; },
    handleSessionState,
    refreshProjectInitialization: () => storage.refresh(),
    initializeProject: () => storage.initializeProject(),
    cleanProject: () => storage.cleanProject(),
    autoCleanProject: (workspace: string) => storage.autoCleanProject(workspace),
    runAction,
    openDiff,
    closeDiff,
    refresh,
    observeProjectChange,
    scheduleProjectSync,
    reset,
  };
}

function registryActionBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("registry actions are unavailable while the agent is running")
    || message.includes("registry actions are unavailable while the session is busy");
}
