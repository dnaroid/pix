import { invoke } from "@tauri-apps/api/core";

type ProjectPiStorageSnapshot = {
  totalBytes: number | null;
  cleanupBytes: number;
  cleanupAvailable: boolean;
};

const PROJECT_LOCAL_INSPECTION_TIMEOUT_MS = 5_000;

type RegistryProjectStorageOptions = {
  workspace: () => string;
  /** True while a mutating action/background sync already owns exclusivity. */
  busy: () => boolean;
  setActionId: (actionId: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  loadProjectTasks: (workspace: string) => void | Promise<void>;
  loadProjectDocuments: (workspace: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
  /** Called after a successful initialize/cleanup so callers can re-check the registry snapshot. */
  onChanged?: () => void;
};

/**
 * Owns local `.pi` project-scaffold state: initialized flag, byte-size/
 * reclaimable storage meter, and the initialize/clean/auto-clean actions.
 * Separated from registry sync/catalog/diff because it is disk housekeeping,
 * not a registry action, even though it shares the panel's action mutex.
 */
export function createRegistryProjectStorage(options: RegistryProjectStorageOptions) {
  let initialized = $state<boolean | undefined>(undefined);
  let sizeBytes = $state<number | null | undefined>(undefined);
  let cleanupBytes = $state<number | undefined>(undefined);
  let cleanupAvailable = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let loadGeneration = 0;
  let lifecycleGeneration = 0;

  async function refresh(): Promise<void> {
    const workspace = options.workspace();
    const requestGeneration = ++loadGeneration;
    const requestLifecycle = lifecycleGeneration;
    if (!workspace) {
      initialized = undefined;
      sizeBytes = undefined;
      cleanupBytes = undefined;
      cleanupAvailable = false;
      loading = false;
      error = null;
      return;
    }
    loading = true;
    error = null;
    const [initializedResult, storageResult] = await Promise.allSettled([
      withTimeout(invoke<boolean>("project_pi_initialized", { workspace }), "Project state inspection"),
      withTimeout(invoke<ProjectPiStorageSnapshot>("project_pi_storage", { workspace }), ".pi storage inspection"),
    ]);
    if (requestGeneration !== loadGeneration || requestLifecycle !== lifecycleGeneration || options.workspace() !== workspace) return;
    if (initializedResult.status === "fulfilled") initialized = initializedResult.value;
    else options.reportError(initializedResult.reason);
    if (storageResult.status === "fulfilled") {
      sizeBytes = storageResult.value.totalBytes;
      cleanupBytes = storageResult.value.cleanupBytes;
      cleanupAvailable = storageResult.value.cleanupAvailable;
      error = null;
    } else {
      cleanupAvailable = false;
      error = storageErrorLabel(storageResult.reason);
    }
    loading = false;
  }

  async function initializeProject(): Promise<boolean> {
    const workspace = options.workspace();
    const requestLifecycle = lifecycleGeneration;
    const current = () => requestLifecycle === lifecycleGeneration && options.workspace() === workspace;
    if (!workspace || options.busy()) return false;

    options.setActionId("initialize-project");
    options.setErrorMessage(null);
    let didInitialize = false;
    try {
      await invoke("initialize_project_pi", { workspace });
      if (!current()) return false;
      initialized = true;
      await Promise.all([
        Promise.resolve(options.loadProjectTasks(workspace)),
        Promise.resolve(options.loadProjectDocuments(workspace)),
      ]);
      didInitialize = current();
      return didInitialize;
    } catch (caught) {
      if (current()) options.reportError(caught);
      return false;
    } finally {
      if (current()) {
        options.setActionId(null);
        options.onChanged?.();
        if (didInitialize) void refresh();
      }
    }
  }

  async function cleanProject(): Promise<boolean> {
    const workspace = options.workspace();
    const requestLifecycle = lifecycleGeneration;
    const current = () => requestLifecycle === lifecycleGeneration && options.workspace() === workspace;
    if (!workspace || options.busy()) return false;

    options.setActionId("cleanup-project");
    options.setErrorMessage(null);
    try {
      await invoke<number>("clean_project_pi", { workspace });
      if (!current()) return false;
      await refresh();
      return current();
    } catch (caught) {
      if (current()) options.reportError(caught);
      return false;
    } finally {
      if (current()) {
        options.setActionId(null);
        options.onChanged?.();
      }
    }
  }

  async function autoCleanProject(workspace: string): Promise<void> {
    if (!workspace) return;
    const requestLifecycle = lifecycleGeneration;
    try {
      await invoke<number>("auto_clean_project_pi", { workspace });
    } catch {
      return;
    }
    if (requestLifecycle !== lifecycleGeneration || options.workspace() !== workspace) return;
    await refresh();
  }

  function reset(): void {
    lifecycleGeneration += 1;
    loadGeneration += 1;
    initialized = undefined;
    sizeBytes = undefined;
    cleanupBytes = undefined;
    cleanupAvailable = false;
    loading = false;
    error = null;
  }

  return {
    get initialized() { return initialized; },
    get sizeBytes() { return sizeBytes; },
    get cleanupBytes() { return cleanupBytes; },
    get cleanupAvailable() { return cleanupAvailable; },
    get loading() { return loading; },
    get error() { return error; },
    refresh,
    initializeProject,
    cleanProject,
    autoCleanProject,
    reset,
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), PROJECT_LOCAL_INSPECTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function storageErrorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("timed out") ? "Storage meter timed out" : "Storage meter unavailable";
}
