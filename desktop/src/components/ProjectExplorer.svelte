<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import File from "@lucide/svelte/icons/file";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import ImageIcon from "@lucide/svelte/icons/image";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { onDestroy, tick } from "svelte";
  import { isTypeaheadKey, linearFocusIndex, typeaheadFocusIndex } from "../lib/keyboard-navigation";
  import {
    flattenProjectTree,
    PROJECT_TREE_DRAG_STATE_EVENT,
    PROJECT_TREE_DROP_EVENT,
    PROJECT_TREE_DROP_TARGET_SELECTOR,
    projectTreeDragPayload,
    projectTreeParentIndex,
    type ProjectTreeEntry,
  } from "../lib/project-tree";

  let {
    workspace,
    externalEditorLabel,
    refreshKey,
    onListDirectory,
    onOpenFile,
    onOpenExternal,
    onHealthChange,
  }: {
    workspace: string;
    externalEditorLabel: string;
    refreshKey: number;
    onListDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onOpenFile: (path: string) => void;
    onOpenExternal: (path: string) => void;
    onHealthChange?: (error: string | null) => void;
  } = $props();

  let entriesByDirectory = $state<Record<string, ProjectTreeEntry[]>>({});
  let expandedDirectories = $state<string[]>([]);
  let loadingDirectories = $state<string[]>([]);
  let errorByDirectory = $state<Record<string, string>>({});
  let selectedPath = $state<string | null>(null);
  let focusedPath = $state<string | null>(null);
  let treeRoot = $state<HTMLDivElement | null>(null);
  let draggedEntry = $state<ProjectTreeEntry | null>(null);
  let projectEntryDragging = $state(false);
  let dragClientX = $state(0);
  let dragClientY = $state(0);
  let generation = 0;
  let dragPointerId: number | null = null;
  let dragSource: HTMLButtonElement | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let projectDropTarget: HTMLElement | null = null;
  let suppressEntryClick = false;
  let previousDragUserSelect: string | null = null;
  let previousDragCursor: string | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;
  const dragThreshold = 4;

  const rootEntries = $derived(entriesByDirectory[""] ?? []);
  const rows = $derived(flattenProjectTree(
    rootEntries,
    entriesByDirectory,
    new Set(expandedDirectories),
  ));
  const rootLoading = $derived(loadingDirectories.includes(""));
  const rootError = $derived(errorByDirectory[""]);
  const tabbablePath = $derived.by(() => {
    const visiblePaths = new Set(rows.map((row) => row.entry.path));
    if (focusedPath && visiblePaths.has(focusedPath)) return focusedPath;
    if (selectedPath && visiblePaths.has(selectedPath)) return selectedPath;
    return rows[0]?.entry.path ?? null;
  });

  onDestroy(() => {
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
  });

  $effect(() => {
    const currentWorkspace = workspace;
    refreshKey;
    const nextGeneration = ++generation;
    let cancelled = false;
    entriesByDirectory = {};
    expandedDirectories = [];
    loadingDirectories = [];
    errorByDirectory = {};
    selectedPath = null;
    focusedPath = null;
    clearProjectEntryDrag();
    queueMicrotask(() => {
      if (!cancelled && nextGeneration === generation) onHealthChange?.(null);
    });
    // Do not call loadDirectory synchronously from the reactive effect: its
    // reads of loading/error state would become effect dependencies and could
    // retrigger the whole explorer reset while a directory request is in
    // flight. Schedule the one root request after dependency collection has
    // finished. Child directories are still loaded only on explicit expand.
    if (currentWorkspace) {
      queueMicrotask(() => {
        if (!cancelled && nextGeneration === generation) void loadDirectory("", nextGeneration);
      });
    }
    return () => {
      cancelled = true;
      if (generation === nextGeneration) generation += 1;
      onHealthChange?.(null);
    };
  });

  async function loadDirectory(path: string, requestGeneration = generation): Promise<void> {
    if (!workspace || loadingDirectories.includes(path)) return;
    loadingDirectories = [...loadingDirectories, path];
    const nextErrors = { ...errorByDirectory };
    delete nextErrors[path];
    errorByDirectory = nextErrors;
    reportHealth();
    try {
      const entries = await onListDirectory(path);
      if (requestGeneration !== generation) return;
      entriesByDirectory = { ...entriesByDirectory, [path]: entries };
      reportHealth();
    } catch (error) {
      if (requestGeneration !== generation) return;
      errorByDirectory = {
        ...errorByDirectory,
        [path]: error instanceof Error ? error.message : String(error),
      };
      reportHealth();
    } finally {
      if (requestGeneration === generation) {
        loadingDirectories = loadingDirectories.filter((candidate) => candidate !== path);
      }
    }
  }

  function reportHealth(): void {
    onHealthChange?.(Object.values(errorByDirectory).find((message) => message.trim()) ?? null);
  }

  function toggleDirectory(path: string): void {
    if (expandedDirectories.includes(path)) {
      expandedDirectories = expandedDirectories.filter((candidate) => candidate !== path);
      return;
    }
    expandedDirectories = [...expandedDirectories, path];
    if (!entriesByDirectory[path]) void loadDirectory(path);
  }

  function openFile(path: string): void {
    selectedPath = path;
    onOpenFile(path);
  }

  async function focusTreeRow(index: number): Promise<void> {
    const row = rows[index];
    if (!row) return;
    focusedPath = row.entry.path;
    await tick();
    const item = treeRoot?.querySelector<HTMLButtonElement>(
      `[data-project-tree-path="${CSS.escape(row.entry.path)}"]`,
    );
    item?.focus();
    item?.scrollIntoView({ block: "nearest" });
  }

  function handleTreeItemKeydown(event: KeyboardEvent, index: number, entry: ProjectTreeEntry): void {
    const linearIndex = linearFocusIndex(index, event.key, rows.length, "vertical", false);
    if (linearIndex !== null && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      void focusTreeRow(linearIndex);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (entry.kind !== "directory") return;
      if (!expandedDirectories.includes(entry.path)) {
        toggleDirectory(entry.path);
        return;
      }
      const next = rows[index + 1];
      if (next && next.depth > rows[index]!.depth) void focusTreeRow(index + 1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (entry.kind === "directory" && expandedDirectories.includes(entry.path)) {
        toggleDirectory(entry.path);
        return;
      }
      const parentIndex = projectTreeParentIndex(rows, index);
      if (parentIndex !== null) void focusTreeRow(parentIndex);
      return;
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      onOpenExternal(entry.path);
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
    let nextIndex = typeaheadFocusIndex(rows.map((row) => row.entry.name), index, query);
    if (nextIndex === null && query.length > 1) {
      query = key;
      nextIndex = typeaheadFocusIndex(rows.map((row) => row.entry.name), index, query);
    }
    typeaheadQuery = query;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadTimer = null;
    }, 700);
    if (nextIndex !== null) void focusTreeRow(nextIndex);
  }

  function fileIconKind(path: string): "text" | "code" | "image" | "file" {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    if (["md", "mdx", "txt", "log", "rst"].includes(extension)) return "text";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(extension)) return "image";
    if ([
      "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "html", "svelte",
      "rs", "py", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "sh", "bash", "zsh", "yaml", "yml", "toml",
    ].includes(extension)) return "code";
    return "file";
  }

  function stopAndOpenExternal(event: MouseEvent, path: string): void {
    event.stopPropagation();
    onOpenExternal(path);
  }

  function activateProjectEntry(event: MouseEvent, entry: ProjectTreeEntry): void {
    if (suppressEntryClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (entry.kind === "directory") toggleDirectory(entry.path);
    else openFile(entry.path);
  }

  function startProjectEntryPointerDrag(event: PointerEvent, entry: ProjectTreeEntry): void {
    if (event.button !== 0) return;
    clearProjectEntryDrag();
    dragPointerId = event.pointerId;
    dragSource = event.currentTarget as HTMLButtonElement;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragClientX = event.clientX;
    dragClientY = event.clientY;
    draggedEntry = entry;
    try {
      dragSource.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience; window hit-testing still handles the drop.
    }
  }

  function moveProjectEntryPointerDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId || !draggedEntry) return;
    dragClientX = event.clientX;
    dragClientY = event.clientY;
    const started = document.documentElement.dataset.pixProjectPathDragging === "true";
    if (!started) {
      if (Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < dragThreshold) return;
      setDocumentProjectDragState(true);
    }
    event.preventDefault();
    setProjectDropTarget(projectDropTargetAt(event.clientX, event.clientY));
  }

  function finishProjectEntryPointerDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    const started = document.documentElement.dataset.pixProjectPathDragging === "true";
    const entry = draggedEntry;
    if (started && entry) {
      event.preventDefault();
      const target = projectDropTargetAt(event.clientX, event.clientY);
      target?.dispatchEvent(new CustomEvent(PROJECT_TREE_DROP_EVENT, {
        detail: projectTreeDragPayload(entry),
      }));
      suppressEntryClick = true;
      window.setTimeout(() => {
        suppressEntryClick = false;
      }, 0);
    }
    clearProjectEntryDrag();
  }

  function cancelProjectEntryPointerDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    clearProjectEntryDrag();
  }

  function projectDropTargetAt(clientX: number, clientY: number): HTMLElement | null {
    return (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
      ?.closest<HTMLElement>(PROJECT_TREE_DROP_TARGET_SELECTOR) ?? null;
  }

  function setProjectDropTarget(target: HTMLElement | null): void {
    if (projectDropTarget === target) return;
    projectDropTarget?.dispatchEvent(new CustomEvent(PROJECT_TREE_DRAG_STATE_EVENT, {
      detail: { active: false },
    }));
    projectDropTarget = target;
    projectDropTarget?.dispatchEvent(new CustomEvent(PROJECT_TREE_DRAG_STATE_EVENT, {
      detail: { active: true },
    }));
  }

  function clearProjectEntryDrag(): void {
    setProjectDropTarget(null);
    if (dragSource && dragPointerId !== null) {
      try {
        if (dragSource.hasPointerCapture(dragPointerId)) dragSource.releasePointerCapture(dragPointerId);
      } catch {
        // Ignore stale pointer-capture state during teardown.
      }
    }
    dragPointerId = null;
    dragSource = null;
    draggedEntry = null;
    setDocumentProjectDragState(false);
  }

  function setDocumentProjectDragState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (root.dataset.pixProjectPathDragging === "true") return;
      projectEntryDragging = true;
      previousDragUserSelect = root.style.userSelect;
      previousDragCursor = root.style.cursor;
      root.dataset.pixProjectPathDragging = "true";
      root.style.userSelect = "none";
      root.style.cursor = "grabbing";
      return;
    }
    projectEntryDragging = false;
    delete root.dataset.pixProjectPathDragging;
    if (previousDragUserSelect !== null) {
      root.style.userSelect = previousDragUserSelect;
      previousDragUserSelect = null;
    }
    if (previousDragCursor !== null) {
      root.style.cursor = previousDragCursor;
      previousDragCursor = null;
    }
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Project files">
  <div
    bind:this={treeRoot}
    class="min-h-0 flex-1 overflow-auto py-1"
    role="tree"
    aria-label="Project files"
  >
    {#if rootLoading && rootEntries.length === 0}
      <div class="flex items-center justify-center gap-1.5 py-8 text-[11px] text-muted-foreground">
        <RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading project files…
      </div>
    {:else if rootError}
      <div class="mx-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-[11px] leading-4 text-tool-error">
        {rootError}
      </div>
    {:else if rootEntries.length === 0}
      <div class="px-3 py-8 text-center text-[11px] text-muted-foreground">This project folder is empty.</div>
    {:else}
      {#each rows as row, index (row.entry.path)}
        {@const entry = row.entry}
        {@const hiddenEntry = entry.name.startsWith(".")}
        {@const expanded = entry.kind === "directory" && expandedDirectories.includes(entry.path)}
        {@const directoryLoading = entry.kind === "directory" && loadingDirectories.includes(entry.path)}
        <div
          class={[
            "group flex h-7 w-full min-w-max items-center pr-1 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
            selectedPath === entry.path ? "bg-sidebar-accent/70" : "",
          ]}
          style:padding-left={`${4 + row.depth * 14}px`}
          role="presentation"
        >
          <button
            class={[
              "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left text-[11px] text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              hiddenEntry && selectedPath !== entry.path
                ? "opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                : "",
            ]}
            type="button"
            role="treeitem"
            title={`${entry.path} · Shift+Enter opens in ${externalEditorLabel}`}
            aria-level={row.depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={selectedPath === entry.path}
            aria-keyshortcuts="Shift+Enter"
            tabindex={tabbablePath === entry.path ? 0 : -1}
            data-project-tree-path={entry.path}
            onfocus={() => focusedPath = entry.path}
            onkeydown={(event) => handleTreeItemKeydown(event, index, entry)}
            onclick={(event) => activateProjectEntry(event, entry)}
            onpointerdown={(event) => startProjectEntryPointerDrag(event, entry)}
            onpointermove={moveProjectEntryPointerDrag}
            onpointerup={finishProjectEntryPointerDrag}
            onpointercancel={cancelProjectEntryPointerDrag}
          >
            {#if entry.kind === "directory"}
              <span class="grid h-4 w-4 shrink-0 place-items-center text-muted-foreground">
                {#if directoryLoading}
                  <RotateCw class="h-3 w-3 animate-spin" aria-hidden="true" />
                {:else}
                  <ChevronRight class={["h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : ""]} aria-hidden="true" />
                {/if}
              </span>
              <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
            {:else}
              <span class="w-4 shrink-0" aria-hidden="true"></span>
              {@const iconKind = fileIconKind(entry.path)}
              {#if iconKind === "text"}<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "code"}<FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "image"}<ImageIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else}<File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
            {/if}
            <span class="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>

          <button
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
            type="button"
            tabindex="-1"
            aria-hidden="true"
            title={`Open ${entry.name} in ${externalEditorLabel}`}
            onclick={(event) => stopAndOpenExternal(event, entry.path)}
          >
            <ExternalLink class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {#if entry.kind === "directory" && expanded && errorByDirectory[entry.path]}
          <div
            class="pr-2 text-[11px] leading-4 text-tool-error"
            style:padding-left={`${34 + (row.depth + 1) * 14}px`}
          >{errorByDirectory[entry.path]}</div>
        {/if}
      {/each}
    {/if}
  </div>

  {#if draggedEntry && projectEntryDragging}
    <div
      class="pointer-events-none fixed z-50 flex max-w-80 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[11px] text-popover-foreground shadow-md"
      style:left={`${dragClientX + 12}px`}
      style:top={`${dragClientY + 12}px`}
    >
      {#if draggedEntry.kind === "directory"}
        <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
      {:else}
        <File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <span class="block truncate">{draggedEntry.kind === "directory" ? `${draggedEntry.path}/` : draggedEntry.path}</span>
    </div>
  {/if}
</section>
