import { tick, untrack } from "svelte";
import { isTypeaheadKey, linearFocusIndex, typeaheadFocusIndex } from "../lib/keyboard-navigation";
import {
  flattenProjectTree,
  projectTreeParentIndex,
  type ProjectTreeEntry,
} from "../lib/project-tree";

interface ProjectExplorerTreeControllerOptions {
  readonly workspace: () => string;
  readonly refreshKey: () => number;
  readonly root: () => HTMLDivElement | null;
  readonly onListDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
  readonly onOpenFile: (path: string) => void;
  readonly onOpenExternal: (path: string) => void;
  readonly onHealthChange: (error: string | null) => void;
  readonly clearDrag: () => void;
}

export function createProjectExplorerTreeController(options: ProjectExplorerTreeControllerOptions) {
  const state = $state({
    entriesByDirectory: {} as Record<string, ProjectTreeEntry[]>,
    expandedDirectories: [] as string[],
    loadingDirectories: [] as string[],
    errorByDirectory: {} as Record<string, string>,
    selectedPath: null as string | null,
    focusedPath: null as string | null,
  });
  let generation = 0;
  let observedWorkspace: string | undefined;
  let observedRefreshKey: number | undefined;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;
  const directoryRequestVersions = new Map<string, number>();

  $effect(() => {
    const currentWorkspace = options.workspace();
    const currentRefreshKey = options.refreshKey();
    const workspaceChanged = currentWorkspace !== observedWorkspace;
    const refreshChanged = currentRefreshKey !== observedRefreshKey;
    observedWorkspace = currentWorkspace;
    observedRefreshKey = currentRefreshKey;
    if (!workspaceChanged && !refreshChanged) return;

    const nextGeneration = ++generation;
    const refreshPaths = untrack(() => {
      if (workspaceChanged) {
        state.entriesByDirectory = {};
        state.expandedDirectories = [];
        state.selectedPath = null;
        state.focusedPath = null;
        directoryRequestVersions.clear();
      }
      state.loadingDirectories = [];
      state.errorByDirectory = {};
      options.clearDrag();
      return workspaceChanged ? [""] : ["", ...new Set(state.expandedDirectories)];
    });
    queueMicrotask(() => {
      if (nextGeneration === generation) options.onHealthChange(null);
    });
    // Keep directory loading outside dependency collection so request state cannot
    // retrigger the explorer lifecycle while a request is in flight.
    if (currentWorkspace) {
      queueMicrotask(() => {
        if (nextGeneration !== generation) return;
        for (const path of refreshPaths) void loadDirectory(path, nextGeneration);
      });
    }
  });

  function rows() {
    return flattenProjectTree(
      state.entriesByDirectory[""] ?? [],
      state.entriesByDirectory,
      new Set(state.expandedDirectories),
    );
  }

  async function loadDirectory(path: string, requestGeneration = generation, force = false): Promise<void> {
    if (!options.workspace() || (!force && state.loadingDirectories.includes(path))) return;
    const requestVersion = (directoryRequestVersions.get(path) ?? 0) + 1;
    directoryRequestVersions.set(path, requestVersion);
    if (!state.loadingDirectories.includes(path)) {
      state.loadingDirectories = [...state.loadingDirectories, path];
    }
    const nextErrors = { ...state.errorByDirectory };
    delete nextErrors[path];
    state.errorByDirectory = nextErrors;
    reportHealth();
    try {
      const entries = await options.onListDirectory(path);
      if (requestGeneration !== generation || directoryRequestVersions.get(path) !== requestVersion) return;
      state.entriesByDirectory = { ...state.entriesByDirectory, [path]: entries };
      reportHealth();
    } catch (error) {
      if (requestGeneration !== generation || directoryRequestVersions.get(path) !== requestVersion) return;
      state.errorByDirectory = {
        ...state.errorByDirectory,
        [path]: error instanceof Error ? error.message : String(error),
      };
      reportHealth();
    } finally {
      if (requestGeneration === generation && directoryRequestVersions.get(path) === requestVersion) {
        state.loadingDirectories = state.loadingDirectories.filter((candidate) => candidate !== path);
      }
    }
  }

  async function refreshDirectory(path: string): Promise<void> {
    await loadDirectory(path, generation, true);
  }

  function reportHealth(): void {
    options.onHealthChange(Object.values(state.errorByDirectory).find((message) => message.trim()) ?? null);
  }

  function toggleDirectory(path: string): void {
    if (state.expandedDirectories.includes(path)) {
      state.expandedDirectories = state.expandedDirectories.filter((candidate) => candidate !== path);
      return;
    }
    state.expandedDirectories = [...state.expandedDirectories, path];
    if (!state.entriesByDirectory[path]) void loadDirectory(path);
  }

  function openFile(path: string): void {
    state.selectedPath = path;
    options.onOpenFile(path);
  }

  function ensureDirectoryExpanded(path: string): void {
    if (!path || state.expandedDirectories.includes(path)) return;
    state.expandedDirectories = [...state.expandedDirectories, path];
  }

  async function focusRow(index: number): Promise<void> {
    const row = rows()[index];
    if (!row) return;
    state.focusedPath = row.entry.path;
    await tick();
    const item = options.root()?.querySelector<HTMLButtonElement>(
      `[data-project-tree-path="${CSS.escape(row.entry.path)}"]`,
    );
    item?.focus();
    item?.scrollIntoView({ block: "nearest" });
  }

  async function focusPath(path: string): Promise<void> {
    const index = rows().findIndex((row) => row.entry.path === path);
    if (index >= 0) await focusRow(index);
  }

  function invalidateDirectoryRequests(pathPrefix: string): void {
    for (const path of directoryRequestVersions.keys()) {
      if (!sameOrDescendantPath(path, pathPrefix)) continue;
      directoryRequestVersions.set(path, (directoryRequestVersions.get(path) ?? 0) + 1);
    }
    state.loadingDirectories = state.loadingDirectories.filter((path) => !sameOrDescendantPath(path, pathPrefix));
  }

  function remapPath(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    invalidateDirectoryRequests(oldPath);
    const remap = (path: string): string => remapProjectPath(path, oldPath, newPath);
    const nextEntries: Record<string, ProjectTreeEntry[]> = {};
    for (const [directory, entries] of Object.entries(state.entriesByDirectory)) {
      nextEntries[remap(directory)] = entries.map((entry) => {
        const path = remap(entry.path);
        return path === entry.path ? entry : { ...entry, path, name: path.split("/").at(-1) ?? entry.name };
      });
    }
    const nextErrors: Record<string, string> = {};
    for (const [directory, error] of Object.entries(state.errorByDirectory)) nextErrors[remap(directory)] = error;
    state.entriesByDirectory = nextEntries;
    state.errorByDirectory = nextErrors;
    state.expandedDirectories = state.expandedDirectories.map(remap);
    if (state.selectedPath) state.selectedPath = remap(state.selectedPath);
    if (state.focusedPath) state.focusedPath = remap(state.focusedPath);
  }

  function focusFallbackAfterRemoval(path: string): string | null {
    const visibleRows = rows();
    const index = visibleRows.findIndex((row) => row.entry.path === path);
    if (index < 0) return state.focusedPath && !sameOrDescendantPath(state.focusedPath, path) ? state.focusedPath : null;
    for (let candidate = index + 1; candidate < visibleRows.length; candidate += 1) {
      const nextPath = visibleRows[candidate]?.entry.path;
      if (nextPath && !sameOrDescendantPath(nextPath, path)) return nextPath;
    }
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const nextPath = visibleRows[candidate]?.entry.path;
      if (nextPath && !sameOrDescendantPath(nextPath, path)) return nextPath;
    }
    return null;
  }

  function removePath(path: string): void {
    invalidateDirectoryRequests(path);
    const nextEntries: Record<string, ProjectTreeEntry[]> = {};
    for (const [directory, entries] of Object.entries(state.entriesByDirectory)) {
      if (sameOrDescendantPath(directory, path)) continue;
      nextEntries[directory] = entries.filter((entry) => !sameOrDescendantPath(entry.path, path));
    }
    const nextErrors: Record<string, string> = {};
    for (const [directory, error] of Object.entries(state.errorByDirectory)) {
      if (!sameOrDescendantPath(directory, path)) nextErrors[directory] = error;
    }
    state.entriesByDirectory = nextEntries;
    state.errorByDirectory = nextErrors;
    state.expandedDirectories = state.expandedDirectories.filter((candidate) => !sameOrDescendantPath(candidate, path));
    if (state.selectedPath && sameOrDescendantPath(state.selectedPath, path)) state.selectedPath = null;
    if (state.focusedPath && sameOrDescendantPath(state.focusedPath, path)) state.focusedPath = null;
  }

  function handleKeydown(event: KeyboardEvent, index: number, entry: ProjectTreeEntry): void {
    const visibleRows = rows();
    const linearIndex = linearFocusIndex(index, event.key, visibleRows.length, "vertical", false);
    if (linearIndex !== null && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      void focusRow(linearIndex);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (entry.kind !== "directory") return;
      if (!state.expandedDirectories.includes(entry.path)) {
        toggleDirectory(entry.path);
        return;
      }
      const next = visibleRows[index + 1];
      if (next && next.depth > visibleRows[index]!.depth) void focusRow(index + 1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (entry.kind === "directory" && state.expandedDirectories.includes(entry.path)) {
        toggleDirectory(entry.path);
        return;
      }
      const parentIndex = projectTreeParentIndex(visibleRows, index);
      if (parentIndex !== null) void focusRow(parentIndex);
      return;
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      options.onOpenExternal(entry.path);
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (entry.kind === "directory") toggleDirectory(entry.path);
      else openFile(entry.path);
      return;
    }

    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = typeaheadQuery.length === 1 && typeaheadQuery === key ? key : `${typeaheadQuery}${key}`;
    let nextIndex = typeaheadFocusIndex(visibleRows.map((row) => row.entry.name), index, query);
    if (nextIndex === null && query.length > 1) {
      query = key;
      nextIndex = typeaheadFocusIndex(visibleRows.map((row) => row.entry.name), index, query);
    }
    typeaheadQuery = query;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadTimer = null;
    }, 700);
    if (nextIndex !== null) void focusRow(nextIndex);
  }

  function dispose(): void {
    generation += 1;
    options.onHealthChange(null);
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  return {
    state,
    get rows() { return rows(); },
    get rootEntries() { return state.entriesByDirectory[""] ?? []; },
    get rootLoading() { return state.loadingDirectories.includes(""); },
    get rootError() { return state.errorByDirectory[""]; },
    get tabbablePath() {
      const visibleRows = rows();
      const visiblePaths = new Set(visibleRows.map((row) => row.entry.path));
      if (state.focusedPath && visiblePaths.has(state.focusedPath)) return state.focusedPath;
      if (state.selectedPath && visiblePaths.has(state.selectedPath)) return state.selectedPath;
      return visibleRows[0]?.entry.path ?? null;
    },
    toggleDirectory,
    ensureDirectoryExpanded,
    openFile,
    refreshDirectory,
    focusPath,
    remapPath,
    focusFallbackAfterRemoval,
    removePath,
    handleKeydown,
    dispose,
  };
}

function sameOrDescendantPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function remapProjectPath(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix;
  return path.startsWith(`${oldPrefix}/`) ? `${newPrefix}${path.slice(oldPrefix.length)}` : path;
}
