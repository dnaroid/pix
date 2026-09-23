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
  operationRunning: () => boolean;
  workspace: () => string;
  sessionWorkspace: (sessionId: string) => string | undefined;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  loadProjectTasks: (workspace: string) => void | Promise<void>;
  loadProjectDocuments: (workspace: string) => void | Promise<void>;
  loadWorkspaceSettings?: (workspace: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
};

type ProjectPiStorageSnapshot = {
  totalBytes: number | null;
  cleanupBytes: number;
  cleanupAvailable: boolean;
};

const PROJECT_LOCAL_INSPECTION_TIMEOUT_MS = 5_000;

export function createRegistryStore(options: RegistryStoreOptions) {
  let snapshot = $state<RegistrySnapshot | undefined>(undefined);
  let projectInitialized = $state<boolean | undefined>(undefined);
  let projectPiSizeBytes = $state<number | null | undefined>(undefined);
  let projectPiCleanupBytes = $state<number | undefined>(undefined);
  let projectPiCleanupAvailable = $state(false);
  let projectPiStorageLoading = $state(false);
  let projectPiStorageError = $state<string | null>(null);
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
      && options.workspace()
      && !options.operationRunning()
      && actionId === null
    ),
    sync: async (scope) => {
      const requestClient = options.client();
      const workspace = options.workspace();
      const requestGeneration = lifecycleGeneration;
      if (!requestClient || !workspace) throw new Error("Registry background sync has no active workspace.");
      const next = await requestClient.registryAction(workspace, { action: "push-project", scope });
      if (
        requestGeneration === lifecycleGeneration
        && options.workspace() === workspace
        && options.client() === requestClient
      ) snapshot = next;
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
      projectPiSizeBytes = undefined;
      projectPiCleanupBytes = undefined;
      projectPiCleanupAvailable = false;
      projectPiStorageLoading = false;
      projectPiStorageError = null;
      return;
    }
    projectPiStorageLoading = true;
    projectPiStorageError = null;
    const [initializedResult, storageResult] = await Promise.allSettled([
      withTimeout(
        invoke<boolean>("project_pi_initialized", { workspace }),
        "Project state inspection",
      ),
      withTimeout(
        invoke<ProjectPiStorageSnapshot>("project_pi_storage", { workspace }),
        ".pi storage inspection",
      ),
    ]);
    if (requestGeneration !== projectStateLoadGeneration || options.workspace() !== workspace) return;
    if (initializedResult.status === "fulfilled") projectInitialized = initializedResult.value;
    else options.reportError(initializedResult.reason);
    if (storageResult.status === "fulfilled") {
      projectPiSizeBytes = storageResult.value.totalBytes;
      projectPiCleanupBytes = storageResult.value.cleanupBytes;
      projectPiCleanupAvailable = storageResult.value.cleanupAvailable;
      projectPiStorageError = null;
    } else {
      projectPiCleanupAvailable = false;
      projectPiStorageError = registryStorageErrorLabel(storageResult.reason);
    }
    projectPiStorageLoading = false;
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

  async function cleanProject(): Promise<boolean> {
    const workspace = options.workspace();
    const requestGeneration = lifecycleGeneration;
    const current = () => requestGeneration === lifecycleGeneration && options.workspace() === workspace;
    if (!workspace || actionId !== null || backgroundSyncState.phase === "syncing") return false;

    actionId = "cleanup-project";
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      await invoke<number>("clean_project_pi", { workspace });
      if (!current()) return false;
      await refreshProjectInitialization();
      return current();
    } catch (error) {
      if (current()) options.reportError(error);
      return false;
    } finally {
      if (current()) {
        actionId = null;
        options.setOperationRunning(false);
        backgroundSync.retry();
      }
    }
  }

  async function autoCleanProject(workspace: string): Promise<void> {
    if (!workspace) return;
    const requestGeneration = lifecycleGeneration;
    try {
      await invoke<number>("auto_clean_project_pi", { workspace });
    } catch {
      return;
    }
    if (requestGeneration !== lifecycleGeneration || options.workspace() !== workspace) return;
    await refreshProjectInitialization();
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
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const next = await requestClient.registryAction(workspace, request);
      if (!current()) return;
      snapshot = next;
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
    projectPiSizeBytes = undefined;
    projectPiCleanupBytes = undefined;
    projectPiCleanupAvailable = false;
    projectPiStorageLoading = false;
    projectPiStorageError = null;
    actionId = null;
    backgroundSync.reset();
  }

  function scheduleProjectSync(scope: RegistryProjectSyncScope): void {
    backgroundSync.mark(scope);
  }

  return {
    get snapshot() { return snapshot; },
    get projectInitialized() { return projectInitialized; },
    get projectPiSizeBytes() { return projectPiSizeBytes; },
    get projectPiCleanupBytes() { return projectPiCleanupBytes; },
    get projectPiCleanupAvailable() { return projectPiCleanupAvailable; },
    get projectPiStorageLoading() { return projectPiStorageLoading; },
    get projectPiStorageError() { return projectPiStorageError; },
    get actionId() { return actionId; },
    get backgroundSyncState() { return backgroundSyncState; },
    handleSessionState,
    refreshProjectInitialization,
    initializeProject,
    cleanProject,
    autoCleanProject,
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

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          PROJECT_LOCAL_INSPECTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function registryStorageErrorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("timed out")
    ? "Storage meter timed out"
    : "Storage meter unavailable";
}
