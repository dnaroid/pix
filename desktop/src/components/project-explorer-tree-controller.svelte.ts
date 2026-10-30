import { tick, untrack } from "svelte";
import { isWorkspaceProjectFilePath } from "../lib/project-files";
import { projectSelectionRange, projectSelectionRoots } from "../lib/project-tree-selection";
import { isTypeaheadKey, linearFocusIndex, typeaheadFocusIndex } from "../lib/keyboard-navigation";
import {
  projectTreeRowsWithRoot,
  projectTreeParentIndex,
  reconcileProjectTreeEntries,
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
  readonly onLoadExpandedDirectories: (workspace: string) => Promise<string[]>;
  readonly onPersistExpandedDirectories: (workspace: string, paths: readonly string[]) => Promise<void>;
  readonly clearDrag: () => void;
}

export function createProjectExplorerTreeController(options: ProjectExplorerTreeControllerOptions) {
  const state = $state({
    rootExpanded: true,
    entriesByDirectory: {} as Record<string, ProjectTreeEntry[]>,
    expandedDirectories: [] as string[],
    loadingDirectories: [] as string[],
    errorByDirectory: {} as Record<string, string>,
    selectedPath: null as string | null,
    selectedPaths: [] as string[],
    selectionAnchor: null as string | null,
    focusedPath: null as string | null,
  });
  // Rows look these up once each per render; Set lookups keep a large
  // expanded tree linear instead of scanning the arrays for every row.
  const selectedPathSet = $derived(new Set(state.selectedPaths));
  const expandedDirectorySet = $derived(new Set(state.expandedDirectories));
  const loadingDirectorySet = $derived(new Set(state.loadingDirectories));
  let generation = 0;
  let observedWorkspace: string | undefined;
  let observedRefreshKey: number | undefined;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;
  let expansionRevision = 0;
  let expansionPersistTimer: number | null = null;
  let pendingExpansionPersist: { workspace: string; paths: string[] } | null = null;
  let expansionPersistTail: Promise<void> = Promise.resolve();
  const directoryRequestVersions = new Map<string, number>();
  const directoryLoads = new Map<string, Promise<void>>();
  let revealVersion = 0;
  let disposed = false;

  $effect(() => {
    const currentWorkspace = options.workspace();
    const currentRefreshKey = options.refreshKey();
    const workspaceChanged = currentWorkspace !== observedWorkspace;
    const refreshChanged = currentRefreshKey !== observedRefreshKey;
    observedWorkspace = currentWorkspace;
    observedRefreshKey = currentRefreshKey;
    if (!workspaceChanged && !refreshChanged) return;

    const nextGeneration = ++generation;
    directoryLoads.clear();
    let restoreRevision: number | undefined;
    const refreshPaths = untrack(() => {
      if (workspaceChanged) {
        flushExpandedDirectoriesPersist();
        state.rootExpanded = true;
        state.entriesByDirectory = {};
        state.expandedDirectories = [];
        restoreRevision = ++expansionRevision;
        state.selectedPath = null;
        state.selectedPaths = [];
        state.selectionAnchor = null;
        state.focusedPath = null;
        directoryRequestVersions.clear();
      }
      state.loadingDirectories = [];
      state.errorByDirectory = {};
      options.clearDrag();
      return workspaceChanged ? [""] : ["", ...visibleExpandedDirectories()];
    });
    queueMicrotask(() => {
      if (nextGeneration === generation) options.onHealthChange(null);
    });
    // Keep directory loading outside dependency collection so request state cannot
    // retrigger the explorer lifecycle while a request is in flight.
    if (currentWorkspace) {
      queueMicrotask(() => {
        if (nextGeneration !== generation) return;
        if (workspaceChanged && restoreRevision !== undefined) {
          void restoreExpandedDirectories(currentWorkspace, nextGeneration, restoreRevision);
        }
        for (const path of refreshPaths) void loadDirectory(path, nextGeneration);
      });
    }
  });

  function rows() {
    return projectTreeRowsWithRoot(
      options.workspace(),
      state.entriesByDirectory,
      expandedDirectorySet,
      state.rootExpanded,
    );
  }

  function loadDirectory(path: string, requestGeneration = generation, force = false, background = false): Promise<void> {
    if (!force && directoryLoads.has(path)) return directoryLoads.get(path)!;
    const request = performDirectoryLoad(path, requestGeneration, background);
    directoryLoads.set(path, request);
    void request.finally(() => {
      if (directoryLoads.get(path) === request) directoryLoads.delete(path);
    });
    return request;
  }

  async function performDirectoryLoad(path: string, requestGeneration: number, background: boolean): Promise<void> {
    if (!options.workspace() || disposed) return;
    const requestWorkspace = options.workspace();
    const requestVersion = (directoryRequestVersions.get(path) ?? 0) + 1;
    directoryRequestVersions.set(path, requestVersion);
    function isCurrentRequest(): boolean {
      return !disposed && requestWorkspace === options.workspace() && requestGeneration === generation
        && directoryRequestVersions.get(path) === requestVersion;
    }
    if ((!background || !state.entriesByDirectory[path]) && !state.loadingDirectories.includes(path)) {
      state.loadingDirectories = [...state.loadingDirectories, path];
    }
    if (state.errorByDirectory[path] && !background) {
      const nextErrors = { ...state.errorByDirectory };
      delete nextErrors[path];
      state.errorByDirectory = nextErrors;
    }
    reportHealth();
    try {
      const entries = await options.onListDirectory(path);
      if (!isCurrentRequest()) return;
      const stableEntries = reconcileProjectTreeEntries(state.entriesByDirectory[path], entries);
      if (stableEntries !== state.entriesByDirectory[path]) {
        state.entriesByDirectory = { ...state.entriesByDirectory, [path]: stableEntries };
      }
      if (state.errorByDirectory[path]) {
        const nextErrors = { ...state.errorByDirectory };
        delete nextErrors[path];
        state.errorByDirectory = nextErrors;
      }
      pruneMissingExpandedChildren(path, entries);
      const available = new Set(entries.map((entry) => entry.path));
      state.selectedPaths = state.selectedPaths.filter((candidate) => {
        const child = immediateChildPath(candidate, path);
        return child === null || available.has(child);
      });
      loadExpandedChildren(entries, requestGeneration);
      reportHealth();
    } catch (error) {
      if (!isCurrentRequest()) return;
      state.errorByDirectory = {
        ...state.errorByDirectory,
        [path]: error instanceof Error ? error.message : String(error),
      };
      reportHealth();
    } finally {
      if (isCurrentRequest() && state.loadingDirectories.includes(path)) {
        state.loadingDirectories = state.loadingDirectories.filter((candidate) => candidate !== path);
      }
    }
  }

  async function refreshDirectory(path: string): Promise<void> {
    await loadDirectory(path, generation, true);
  }

  async function refreshVisibleDirectories(): Promise<void> {
    const requestGeneration = generation;
    await Promise.all(["", ...visibleExpandedDirectories()].map((path) => loadDirectory(path, requestGeneration, false, true)));
  }

  function reportHealth(): void {
    options.onHealthChange(Object.values(state.errorByDirectory).find((message) => message.trim()) ?? null);
  }

  function toggleDirectory(path: string): void {
    revealVersion++;
    if (!path) {
      state.rootExpanded = !state.rootExpanded;
      if (!state.rootExpanded) {
        state.focusedPath = "";
        state.expandedDirectories = [];
        expansionRevision += 1;
        schedulePersistExpandedDirectories();
      } else void refreshVisibleDirectories();
      return;
    }
    if (state.expandedDirectories.includes(path)) {
      state.expandedDirectories = state.expandedDirectories.filter((candidate) => !sameOrDescendantPath(candidate, path));
      expansionRevision += 1;
      schedulePersistExpandedDirectories();
      return;
    }
    state.expandedDirectories = [...state.expandedDirectories, path];
    expansionRevision += 1;
    schedulePersistExpandedDirectories();
    // Collapsed directories are not polled, so cached children may be stale.
    // Keep them visible while rereading just the newly exposed branch.
    void loadDirectory(path);
    for (const directory of visibleExpandedDirectories()) {
      if (directory.startsWith(`${path}/`)) void loadDirectory(directory);
    }
  }

  function openFile(path: string): void {
    revealVersion++;
    state.selectedPath = path;
    options.onOpenFile(path);
  }

  function selectEntry(path: string, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}): void {
    if (!path) {
      state.selectedPaths = [];
      state.selectionAnchor = null;
      return;
    }
    const additive = modifiers.metaKey || modifiers.ctrlKey;
    if (modifiers.shiftKey) {
      state.selectionAnchor ??= state.focusedPath || path;
      const range = projectSelectionRange(rows().map((row) => row.entry.path), state.selectionAnchor, path);
      state.selectedPaths = additive ? [...new Set([...state.selectedPaths, ...range])] : range;
    } else {
      state.selectionAnchor = path;
      state.selectedPaths = additive
        ? state.selectedPaths.includes(path) ? state.selectedPaths.filter((candidate) => candidate !== path) : [...state.selectedPaths, path]
        : [path];
    }
  }

  function selectedEntries(entry: ProjectTreeEntry): ProjectTreeEntry[] {
    if (!selectedPathSet.has(entry.path)) return entry.path ? [entry] : [];
    const entries = Object.values(state.entriesByDirectory).flat();
    return projectSelectionRoots(entries.filter((candidate) => selectedPathSet.has(candidate.path)));
  }

  function ensureDirectoryExpanded(path: string): void {
    state.rootExpanded = true;
    if (!path || state.expandedDirectories.includes(path)) return;
    state.expandedDirectories = [...state.expandedDirectories, path];
    expansionRevision += 1;
    schedulePersistExpandedDirectories();
  }

  async function focusRow(index: number): Promise<void> {
    const row = rows()[index];
    if (!row) return;
    const requestGeneration = generation;
    const requestWorkspace = options.workspace();
    const requestRevealVersion = revealVersion;
    state.focusedPath = row.entry.path;
    await tick();
    if (requestGeneration !== generation || requestRevealVersion !== revealVersion
      || options.workspace() !== requestWorkspace || state.focusedPath !== row.entry.path) return;
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

  /** Reveal an entry without opening it or replacing the workspace tree root. */
  async function revealPath(rawPath: string): Promise<void> {
    const path = rawPath.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".").join("/");
    if (!isWorkspaceProjectFilePath(rawPath) || !path || disposed) return;
    const requestWorkspace = options.workspace();
    const request = ++revealVersion;
    // Let mount/workspace effects establish the directory generation first.
    await tick();
    if (disposed || request !== revealVersion || options.workspace() !== requestWorkspace) return;
    const requestGeneration = generation;
    const focusedBefore = state.focusedPath;
    const isCurrent = () => !disposed && request === revealVersion && requestGeneration === generation
      && options.workspace() === requestWorkspace && state.focusedPath === focusedBefore;
    state.rootExpanded = true;
    expansionRevision++;
    let parent = "";
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      if (!isCurrent()) return;
      if (!state.entriesByDirectory[parent]) await loadDirectory(parent, requestGeneration);
      if (!isCurrent()) return;
      const childPath = parts.slice(0, index + 1).join("/");
      let entry = state.entriesByDirectory[parent]?.find((entry) => entry.path === childPath);
      // A file may have appeared since the last listing. Refresh only its parent.
      if (!entry && !state.errorByDirectory[parent]) {
        await loadDirectory(parent, requestGeneration, true);
        if (!isCurrent()) return;
        entry = state.entriesByDirectory[parent]?.find((entry) => entry.path === childPath);
      }
      if (!entry) return;
      if (index < parts.length - 1 && entry.kind !== "directory") return;
      if (entry.kind === "directory") ensureDirectoryExpanded(entry.path);
      if (index === parts.length - 1 && entry.kind === "directory" && !state.entriesByDirectory[entry.path]) {
        void loadDirectory(entry.path, requestGeneration);
      }
      parent = childPath;
    }
    if (!isCurrent()) return;
    state.selectedPath = path;
    selectEntry(path);
    await focusPath(path);
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
    state.expandedDirectories = [...new Set(state.expandedDirectories.map(remap))];
    expansionRevision += 1;
    schedulePersistExpandedDirectories();
    if (state.selectedPath) state.selectedPath = remap(state.selectedPath);
    state.selectedPaths = state.selectedPaths.map(remap);
    if (state.selectionAnchor) state.selectionAnchor = remap(state.selectionAnchor);
    if (state.focusedPath) state.focusedPath = remap(state.focusedPath);
  }

  function focusFallbackAfterRemoval(path: string): string | null {
    const visibleRows = rows();
    const index = visibleRows.findIndex((row) => row.entry.path === path);
    if (index < 0) return state.focusedPath !== null && !sameOrDescendantPath(state.focusedPath, path) ? state.focusedPath : null;
    for (let candidate = index + 1; candidate < visibleRows.length; candidate += 1) {
      const nextPath = visibleRows[candidate]?.entry.path;
      if (nextPath !== undefined && !sameOrDescendantPath(nextPath, path)) return nextPath;
    }
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const nextPath = visibleRows[candidate]?.entry.path;
      if (nextPath !== undefined && !sameOrDescendantPath(nextPath, path)) return nextPath;
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
    expansionRevision += 1;
    schedulePersistExpandedDirectories();
    if (state.selectedPath && sameOrDescendantPath(state.selectedPath, path)) state.selectedPath = null;
    state.selectedPaths = state.selectedPaths.filter((candidate) => !sameOrDescendantPath(candidate, path));
    if (state.selectionAnchor && sameOrDescendantPath(state.selectionAnchor, path)) state.selectionAnchor = null;
    if (state.focusedPath && sameOrDescendantPath(state.focusedPath, path)) state.focusedPath = null;
  }

  function handleKeydown(event: KeyboardEvent, index: number, entry: ProjectTreeEntry): void {
    const visibleRows = rows();
    const linearIndex = linearFocusIndex(index, event.key, visibleRows.length, "vertical", false);
    if (linearIndex !== null && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.shiftKey) selectEntry(visibleRows[linearIndex]!.entry.path, event);
      void focusRow(linearIndex);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (entry.kind !== "directory") return;
      if (!isDirectoryExpanded(entry.path)) {
        toggleDirectory(entry.path);
        return;
      }
      const next = visibleRows[index + 1];
      if (next && next.depth > visibleRows[index]!.depth) void focusRow(index + 1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (entry.kind === "directory" && isDirectoryExpanded(entry.path)) {
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
      selectEntry(entry.path, event);
      if (event.key === " ") return;
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
    disposed = true;
    revealVersion++;
    directoryLoads.clear();
    flushExpandedDirectoriesPersist();
    generation += 1;
    options.onHealthChange(null);
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  function isDirectoryExpanded(path: string): boolean {
    return path === "" ? state.rootExpanded : expandedDirectorySet.has(path);
  }

  function isSelected(path: string): boolean {
    return selectedPathSet.has(path);
  }

  function isDirectoryLoading(path: string): boolean {
    return loadingDirectorySet.has(path);
  }

  async function restoreExpandedDirectories(
    workspace: string,
    requestGeneration: number,
    requestRevision: number,
  ): Promise<void> {
    try {
      const restored = await options.onLoadExpandedDirectories(workspace);
      if (
        requestGeneration !== generation
        || requestRevision !== expansionRevision
        || options.workspace() !== workspace
      ) return;
      state.expandedDirectories = restored;
      const rootEntries = state.entriesByDirectory[""];
      if (rootEntries) {
        pruneMissingExpandedChildren("", rootEntries);
        loadExpandedChildren(rootEntries, requestGeneration);
      }
    } catch (error) {
      console.warn("Could not restore Project Explorer expansion state", error);
    }
  }

  function schedulePersistExpandedDirectories(): void {
    const workspace = options.workspace();
    if (!workspace) return;
    pendingExpansionPersist = { workspace, paths: [...state.expandedDirectories] };
    if (expansionPersistTimer !== null) window.clearTimeout(expansionPersistTimer);
    expansionPersistTimer = window.setTimeout(flushExpandedDirectoriesPersist, 300);
  }

  function flushExpandedDirectoriesPersist(): void {
    if (expansionPersistTimer !== null) window.clearTimeout(expansionPersistTimer);
    expansionPersistTimer = null;
    const pending = pendingExpansionPersist;
    pendingExpansionPersist = null;
    if (!pending) return;
    expansionPersistTail = expansionPersistTail
      .catch(() => undefined)
      .then(() => options.onPersistExpandedDirectories(pending.workspace, pending.paths))
      .catch((error) => {
        console.warn("Could not persist Project Explorer expansion state", error);
      });
  }

  function visibleExpandedDirectories(): string[] {
    return rows()
      .filter((row) => row.entry.kind === "directory" && expandedDirectorySet.has(row.entry.path))
      .map((row) => row.entry.path);
  }

  function pruneMissingExpandedChildren(path: string, entries: readonly ProjectTreeEntry[]): void {
    const availableDirectories = new Set(
      entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
    );
    const next = state.expandedDirectories.filter((candidate) => {
      const child = immediateChildPath(candidate, path);
      return child === null || availableDirectories.has(child);
    });
    if (next.length === state.expandedDirectories.length) return;
    state.expandedDirectories = next;
    expansionRevision += 1;
    schedulePersistExpandedDirectories();
  }

  function loadExpandedChildren(entries: readonly ProjectTreeEntry[], requestGeneration: number): void {
    for (const entry of entries) {
      if (
        entry.kind === "directory"
        && expandedDirectorySet.has(entry.path)
        && !state.entriesByDirectory[entry.path]
      ) {
        void loadDirectory(entry.path, requestGeneration);
      }
    }
  }

  return {
    state,
    get rows() { return rows(); },
    get rootEntries() { return state.entriesByDirectory[""] ?? []; },
    get rootLoading() { return loadingDirectorySet.has(""); },
    get rootError() { return state.errorByDirectory[""]; },
    get tabbablePath() {
      const visibleRows = rows();
      const visiblePaths = new Set(visibleRows.map((row) => row.entry.path));
      if (state.focusedPath !== null && visiblePaths.has(state.focusedPath)) return state.focusedPath;
      if (state.selectedPath && visiblePaths.has(state.selectedPath)) return state.selectedPath;
      return visibleRows[0]?.entry.path ?? null;
    },
    toggleDirectory,
    selectEntry,
    selectedEntries,
    selectAll: () => { state.selectedPaths = rows().map((row) => row.entry.path).filter(Boolean); },
    isDirectoryExpanded,
    isSelected,
    isDirectoryLoading,
    ensureDirectoryExpanded,
    openFile,
    refreshDirectory,
    refreshVisibleDirectories,
    focusPath,
    revealPath,
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

function immediateChildPath(path: string, parent: string): string | null {
  if (parent) {
    if (!path.startsWith(`${parent}/`)) return null;
    const remainder = path.slice(parent.length + 1);
    const separator = remainder.indexOf("/");
    return separator < 0 ? path : `${parent}/${remainder.slice(0, separator)}`;
  }
  const separator = path.indexOf("/");
  return separator < 0 ? path : path.slice(0, separator);
}
