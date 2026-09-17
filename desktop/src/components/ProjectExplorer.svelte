<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import File from "@lucide/svelte/icons/file";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import ImageIcon from "@lucide/svelte/icons/image";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { onDestroy } from "svelte";
  import type { ProjectTreeEntry } from "../lib/project-tree";
  import { createProjectExplorerDragController } from "./project-explorer-drag-controller.svelte";
  import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";

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

  let treeRoot = $state<HTMLDivElement | null>(null);
  const dragController = createProjectExplorerDragController();
  const treeController = createProjectExplorerTreeController({
    workspace: () => workspace,
    refreshKey: () => refreshKey,
    root: () => treeRoot,
    onListDirectory: (path) => onListDirectory(path),
    onOpenFile: (path) => onOpenFile(path),
    onOpenExternal: (path) => onOpenExternal(path),
    onHealthChange: (error) => onHealthChange?.(error),
    clearDrag: dragController.clear,
  });
  const treeState = treeController.state;
  const rootEntries = $derived(treeController.rootEntries);
  const rows = $derived(treeController.rows);
  const rootLoading = $derived(treeController.rootLoading);
  const rootError = $derived(treeController.rootError);
  const tabbablePath = $derived(treeController.tabbablePath);

  onDestroy(() => {
    treeController.dispose();
    dragController.clear();
  });

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
    if (dragController.suppressEntryClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (entry.kind === "directory") treeController.toggleDirectory(entry.path);
    else treeController.openFile(entry.path);
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
      <div class="flex items-center justify-center gap-1.5 py-8 text-xs text-muted-foreground">
        <RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading project files…
      </div>
    {:else if rootError}
      <div class="mx-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error">
        {rootError}
      </div>
    {:else if rootEntries.length === 0}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">This project folder is empty.</div>
    {:else}
      {#each rows as row, index (row.entry.path)}
        {@const entry = row.entry}
        {@const hiddenEntry = entry.name.startsWith(".")}
        {@const expanded = entry.kind === "directory" && treeState.expandedDirectories.includes(entry.path)}
        {@const directoryLoading = entry.kind === "directory" && treeState.loadingDirectories.includes(entry.path)}
        <div
          class={[
            "group flex h-7 w-full min-w-max items-center pr-1 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
            treeState.selectedPath === entry.path ? "bg-sidebar-accent/70" : "",
          ]}
          style:padding-left={`${4 + row.depth * 14}px`}
          role="presentation"
        >
          <button
            class={[
              "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left text-xs text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              hiddenEntry && treeState.selectedPath !== entry.path
                ? "opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                : "",
            ]}
            type="button"
            role="treeitem"
            title={`${entry.path} · Shift+Enter opens in ${externalEditorLabel}`}
            aria-level={row.depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={treeState.selectedPath === entry.path}
            aria-keyshortcuts="Shift+Enter"
            tabindex={tabbablePath === entry.path ? 0 : -1}
            data-project-tree-path={entry.path}
            onfocus={() => treeState.focusedPath = entry.path}
            onkeydown={(event) => treeController.handleKeydown(event, index, entry)}
            onclick={(event) => activateProjectEntry(event, entry)}
            onpointerdown={(event) => dragController.start(event, entry)}
            onpointermove={dragController.move}
            onpointerup={dragController.finish}
            onpointercancel={dragController.cancel}
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
        {#if entry.kind === "directory" && expanded && treeState.errorByDirectory[entry.path]}
          <div
            class="pr-2 text-xs leading-4 text-tool-error"
            style:padding-left={`${34 + (row.depth + 1) * 14}px`}
          >{treeState.errorByDirectory[entry.path]}</div>
        {/if}
      {/each}
    {/if}
  </div>

  {#if dragController.entry && dragController.dragging}
    <div
      class="pointer-events-none fixed z-50 flex max-w-80 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow-md"
      style:left={`${dragController.clientX + 12}px`}
      style:top={`${dragController.clientY + 12}px`}
    >
      {#if dragController.entry.kind === "directory"}
        <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
      {:else}
        <File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <span class="block truncate">{dragController.entry.kind === "directory" ? `${dragController.entry.path}/` : dragController.entry.path}</span>
    </div>
  {/if}
</section>
