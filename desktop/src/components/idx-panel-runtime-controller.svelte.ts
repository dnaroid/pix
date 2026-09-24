import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IDX_OPERATION_EXIT_EVENT,
  IDX_OPERATION_OUTPUT_EVENT,
  appendIdxLog,
  reconcileIdxOperationSnapshot,
  type IdxMaintenanceKind,
  type IdxOperationExitEvent,
  type IdxOperationOutputEvent,
  type IdxOperationSnapshot,
  type IdxOverview,
} from "../lib/idx";
import { installManagedIdx } from "../lib/desktop-bootstrap";
import { startCompletionSpacedPoll } from "../lib/completion-spaced-poll";

interface IdxPanelRuntimeControllerOptions {
  readonly workspace: () => string;
  readonly onOverviewChange?: (workspace: string, overview: IdxOverview | undefined) => void;
}

export function createIdxPanelRuntimeController(options: IdxPanelRuntimeControllerOptions) {
  const windowLabel = getCurrentWindow().label;
  let overview = $state<IdxOverview | undefined>();
  let overviewWorkspace = $state("");
  let operations = $state<IdxOperationSnapshot[]>([]);
  let loading = $state(false);
  let overviewRefreshRunning = $state(false);
  let installingIdx = $state(false);
  let error = $state<string | null>(null);
  let loadGeneration = 0;
  let disposed = false;
  let overviewRefreshQueued = false;
  let overviewRefreshGeneration = 0;
  let observedWorkspace: string | undefined;

  $effect(() => {
    const requestWorkspace = options.workspace();
    if (requestWorkspace === observedWorkspace) return;
    observedWorkspace = requestWorkspace;
    const generation = ++loadGeneration;
    queueMicrotask(() => {
      if (!disposed && generation === loadGeneration) void loadWorkspace(requestWorkspace, generation);
    });
  });

  async function loadWorkspace(requestWorkspace: string, generation: number): Promise<void> {
    if (disposed) return;
    if (!requestWorkspace) {
      overview = undefined;
      overviewWorkspace = "";
      options.onOverviewChange?.(requestWorkspace, undefined);
      operations = [];
      loading = false;
      return;
    }
    loading = true;
    error = null;
    try {
      const [nextOverview, nextOperations] = await Promise.all([
        invoke<IdxOverview>("idx_overview", { workspace: requestWorkspace }),
        invoke<IdxOperationSnapshot[]>("idx_operation_list", { windowLabel, workspace: requestWorkspace }),
      ]);
      if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      overview = nextOverview;
      overviewWorkspace = requestWorkspace;
      options.onOverviewChange?.(requestWorkspace, nextOverview);
      operations = nextOperations;
    } catch (caught) {
      if (disposed || generation !== loadGeneration || options.workspace() !== requestWorkspace) return;
      error = errorMessage(caught);
    } finally {
      if (!disposed && generation === loadGeneration) {
        loading = false;
        if (overviewRefreshQueued) {
          overviewRefreshQueued = false;
          queueMicrotask(() => void refreshOverview());
        }
      }
    }
  }

  async function refreshOverview(): Promise<void> {
    const requestWorkspace = options.workspace();
    if (disposed || !requestWorkspace) return;
    if (loading || overviewRefreshRunning) {
      overviewRefreshQueued = true;
      return;
    }
    overviewRefreshRunning = true;
    const generation = ++overviewRefreshGeneration;
    try {
      const next = await invoke<IdxOverview>("idx_overview", { workspace: requestWorkspace });
      if (!disposed && generation === overviewRefreshGeneration && options.workspace() === requestWorkspace) {
        overview = next;
        overviewWorkspace = requestWorkspace;
        options.onOverviewChange?.(requestWorkspace, next);
      }
    } catch (caught) {
      if (!disposed && generation === overviewRefreshGeneration && options.workspace() === requestWorkspace) {
        error = errorMessage(caught);
      }
    } finally {
      overviewRefreshRunning = false;
      if (overviewRefreshQueued && !disposed) {
        overviewRefreshQueued = false;
        queueMicrotask(() => void refreshOverview());
      }
    }
  }

  function refresh(): void {
    if (loading || overviewRefreshRunning || disposed) return;
    const generation = ++loadGeneration;
    void loadWorkspace(options.workspace(), generation);
  }

  async function installIdx(): Promise<void> {
    if (disposed || installingIdx) return;
    installingIdx = true;
    error = null;
    try {
      await installManagedIdx();
      if (!disposed) await refreshOverview();
    } catch (caught) {
      if (!disposed) error = errorMessage(caught);
    } finally {
      if (!disposed) installingIdx = false;
    }
  }

  async function startOperation(kind: IdxMaintenanceKind): Promise<void> {
    const requestWorkspace = options.workspace();
    if (!requestWorkspace || runningOperation()) return;
    error = null;
    try {
      const started = await invoke<IdxOperationSnapshot>("idx_operation_start", {
        request: { windowLabel, workspace: requestWorkspace, kind },
      });
      if (options.workspace() !== requestWorkspace) return;
      operations = [...operations, started];

      // Output or exit events may beat the start command's IPC response. Reload the
      // backend record after registration so those early events are not lost.
      const refreshed = await invoke<IdxOperationSnapshot[]>("idx_operation_list", {
        windowLabel,
        workspace: requestWorkspace,
      });
      if (options.workspace() !== requestWorkspace) return;
      const refreshedStarted = refreshed.find((operation) => operation.id === started.id);
      if (refreshedStarted) {
        operations = operations.map((operation) => operation.id === started.id
          ? reconcileIdxOperationSnapshot(operation, refreshedStarted)
          : operation);
      }
    } catch (caught) {
      if (options.workspace() === requestWorkspace) error = errorMessage(caught);
    }
  }

  async function stopOperation(operation: IdxOperationSnapshot): Promise<void> {
    if (operation.status !== "running") return;
    try {
      await invoke("idx_operation_stop", { windowLabel, operationId: operation.id });
    } catch (caught) {
      error = errorMessage(caught);
    }
  }

  function runningOperation(): IdxOperationSnapshot | undefined {
    return operations.find((operation) => operation.workspace === options.workspace() && operation.status === "running");
  }

  function visibleOperation(): IdxOperationSnapshot | undefined {
    return runningOperation() ?? [...operations].reverse().find((operation) => operation.workspace === options.workspace());
  }

  function setError(message: string | null): void {
    error = message;
  }

  function start(refreshBlocked: () => boolean = () => false): () => void {
    const unlisteners: Array<() => void> = [];
    const stopOverviewPoll = startCompletionSpacedPoll({
      delayMs: 30_000,
      shouldRun: () => !disposed
        && !loading
        && !overviewRefreshRunning
        && !refreshBlocked()
        && !runningOperation(),
      task: refreshOverview,
    });
    void listen<IdxOperationOutputEvent>(IDX_OPERATION_OUTPUT_EVENT, ({ payload }) => {
      if (disposed) return;
      operations = operations.map((operation) => operation.id === payload.operationId
        ? { ...operation, output: appendIdxLog(operation.output, payload.chunk) }
        : operation);
    }).then((unlisten) => disposed ? unlisten() : unlisteners.push(unlisten));
    void listen<IdxOperationExitEvent>(IDX_OPERATION_EXIT_EVENT, ({ payload }) => {
      if (disposed) return;
      operations = operations.map((operation) => operation.id === payload.operationId
        ? { ...operation, status: payload.status, exitCode: payload.exitCode, finishedAtMs: Date.now() }
        : operation);
      void refreshOverview();
    }).then((unlisten) => disposed ? unlisten() : unlisteners.push(unlisten));
    return () => {
      disposed = true;
      loadGeneration += 1;
      overviewRefreshGeneration += 1;
      overviewRefreshQueued = false;
      stopOverviewPoll();
      for (const unlisten of unlisteners) unlisten();
    };
  }

  return {
    get overview() { return overviewWorkspace === options.workspace() ? overview : undefined; },
    get operations() { return operations; },
    get loading() { return loading; },
    get overviewRefreshRunning() { return overviewRefreshRunning; },
    get installingIdx() { return installingIdx; },
    get error() { return error; },
    get runningOperation() { return runningOperation(); },
    get visibleOperation() { return visibleOperation(); },
    get indexReady() { return Boolean(overviewWorkspace === options.workspace() && overview?.available && overview.initialized); },
    refresh,
    refreshOverview,
    installIdx,
    startOperation,
    stopOperation,
    setError,
    start,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
