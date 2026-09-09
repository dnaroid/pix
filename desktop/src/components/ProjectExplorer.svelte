<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import File from "@lucide/svelte/icons/file";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import ImageIcon from "@lucide/svelte/icons/image";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import {
    flattenProjectTree,
    type ProjectTreeEntry,
  } from "../lib/project-tree";

  let {
    workspace,
    externalEditorLabel,
    refreshKey,
    onListDirectory,
    onOpenFile,
    onOpenExternal,
  }: {
    workspace: string;
    externalEditorLabel: string;
    refreshKey: number;
    onListDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onOpenFile: (path: string) => void;
    onOpenExternal: (path: string) => void;
  } = $props();

  let entriesByDirectory = $state<Record<string, ProjectTreeEntry[]>>({});
  let expandedDirectories = $state<string[]>([]);
  let loadingDirectories = $state<string[]>([]);
  let errorByDirectory = $state<Record<string, string>>({});
  let selectedPath = $state<string | null>(null);
  let generation = 0;

  const rootEntries = $derived(entriesByDirectory[""] ?? []);
  const rows = $derived(flattenProjectTree(
    rootEntries,
    entriesByDirectory,
    new Set(expandedDirectories),
  ));
  const rootLoading = $derived(loadingDirectories.includes(""));
  const rootError = $derived(errorByDirectory[""]);

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
    };
  });

  async function loadDirectory(path: string, requestGeneration = generation): Promise<void> {
    if (!workspace || loadingDirectories.includes(path)) return;
    loadingDirectories = [...loadingDirectories, path];
    const nextErrors = { ...errorByDirectory };
    delete nextErrors[path];
    errorByDirectory = nextErrors;
    try {
      const entries = await onListDirectory(path);
      if (requestGeneration !== generation) return;
      entriesByDirectory = { ...entriesByDirectory, [path]: entries };
    } catch (error) {
      if (requestGeneration !== generation) return;
      errorByDirectory = {
        ...errorByDirectory,
        [path]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (requestGeneration === generation) {
        loadingDirectories = loadingDirectories.filter((candidate) => candidate !== path);
      }
    }
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
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Project files">
  <div class="min-h-0 flex-1 overflow-auto py-1">
    {#if rootLoading && rootEntries.length === 0}
      <div class="flex items-center justify-center gap-1.5 py-8 text-[10px] text-muted-foreground">
        <RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading project files…
      </div>
    {:else if rootError}
      <div class="mx-2 rounded-md border border-[var(--tool-error)]/25 bg-[var(--tool-error)]/5 px-2.5 py-2 text-[10px] leading-4 text-[var(--tool-error)]">
        {rootError}
      </div>
    {:else if rootEntries.length === 0}
      <div class="px-3 py-8 text-center text-[10px] text-muted-foreground">This project folder is empty.</div>
    {:else}
      {#each rows as row (row.entry.path)}
        {@const entry = row.entry}
        {@const expanded = entry.kind === "directory" && expandedDirectories.includes(entry.path)}
        {@const directoryLoading = entry.kind === "directory" && loadingDirectories.includes(entry.path)}
        <div
          class={[
            "group flex h-7 w-full min-w-max items-center pr-1 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
            selectedPath === entry.path ? "bg-sidebar-accent/70" : "",
          ]}
          style:padding-left={`${4 + row.depth * 14}px`}
        >
          <button
            class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-[11px] text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            type="button"
            title={entry.path}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            onclick={() => entry.kind === "directory" ? toggleDirectory(entry.path) : openFile(entry.path)}
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
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
            type="button"
            title={`Open ${entry.name} in ${externalEditorLabel}`}
            aria-label={`Open ${entry.path} in ${externalEditorLabel}`}
            onclick={(event) => stopAndOpenExternal(event, entry.path)}
          >
            <ExternalLink class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {#if entry.kind === "directory" && expanded && errorByDirectory[entry.path]}
          <div
            class="pr-2 text-[9px] leading-4 text-[var(--tool-error)]"
            style:padding-left={`${34 + (row.depth + 1) * 14}px`}
          >{errorByDirectory[entry.path]}</div>
        {/if}
      {/each}
    {/if}
  </div>
</section>
