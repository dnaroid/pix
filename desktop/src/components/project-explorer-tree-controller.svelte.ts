import { tick } from "svelte";
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
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;

  $effect(() => {
    const currentWorkspace = options.workspace();
    options.refreshKey();
    const nextGeneration = ++generation;
    let cancelled = false;
    state.entriesByDirectory = {};
    state.expandedDirectories = [];
    state.loadingDirectories = [];
    state.errorByDirectory = {};
    state.selectedPath = null;
    state.focusedPath = null;
    options.clearDrag();
    queueMicrotask(() => {
      if (!cancelled && nextGeneration === generation) options.onHealthChange(null);
    });
    // Keep root loading outside dependency collection so request state cannot
    // retrigger the whole explorer reset while a directory request is in flight.
    if (currentWorkspace) {
      queueMicrotask(() => {
        if (!cancelled && nextGeneration === generation) void loadDirectory("", nextGeneration);
      });
    }
    return () => {
      cancelled = true;
      if (generation === nextGeneration) generation += 1;
      options.onHealthChange(null);
    };
  });

  function rows() {
    return flattenProjectTree(
      state.entriesByDirectory[""] ?? [],
      state.entriesByDirectory,
      new Set(state.expandedDirectories),
    );
  }

  async function loadDirectory(path: string, requestGeneration = generation): Promise<void> {
    if (!options.workspace() || state.loadingDirectories.includes(path)) return;
    state.loadingDirectories = [...state.loadingDirectories, path];
    const nextErrors = { ...state.errorByDirectory };
    delete nextErrors[path];
    state.errorByDirectory = nextErrors;
    reportHealth();
    try {
      const entries = await options.onListDirectory(path);
      if (requestGeneration !== generation) return;
      state.entriesByDirectory = { ...state.entriesByDirectory, [path]: entries };
      reportHealth();
    } catch (error) {
      if (requestGeneration !== generation) return;
      state.errorByDirectory = {
        ...state.errorByDirectory,
        [path]: error instanceof Error ? error.message : String(error),
      };
      reportHealth();
    } finally {
      if (requestGeneration === generation) {
        state.loadingDirectories = state.loadingDirectories.filter((candidate) => candidate !== path);
      }
    }
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
    openFile,
    handleKeydown,
    dispose,
  };
}
