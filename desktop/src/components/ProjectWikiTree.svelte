<script lang="ts">
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import File from "@lucide/svelte/icons/file";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import ImageIcon from "@lucide/svelte/icons/image";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import { getContext, onDestroy, onMount, untrack } from "svelte";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { iconButtonClass } from "../lib/icon-button";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";
  import type { ProjectTreeEntry } from "../lib/project-tree";
  import type { ProjectWikiConfig } from "../lib/project-wiki";
  import { createProjectWikiNavigation, wikiIndexOwner } from "../lib/project-wiki-navigation";
  import { emptyStateClass } from "../lib/status-text";
  import { wikiConsistencyDescription } from "../lib/wiki-consistency-tree";
  import ProjectExplorerNameInput from "./ProjectExplorerNameInput.svelte";
  import { createProjectExplorerNameEditor } from "./project-explorer-name-editor.svelte";
  import { createProjectExplorerOperations } from "./project-explorer-operations.svelte";
  import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";
  import { createWikiConsistencyTreeState } from "./wiki-consistency-tree-state.svelte";
  import { WIKI_CONSISTENCY_CONTEXT, type WikiConsistencyOwner } from "../app/wiki-consistency-owner.svelte";
  import { WIKI_CONFLICTS_NAVIGATION_CONTEXT, type WikiConflictsNavigation } from "../app/workbench-wiki-conflicts.svelte";
  import { createProjectExplorerNativeMenu } from "../lib/project-explorer-native-menu";
  import { wikiBranchReportLanguage, wikiTreeConflictMenuActions } from "../lib/wiki-tree-menu";

  let { workspace, config, activePath, onOpenFile, onOpenFiles, onOpenExternal, onBeforeMutation, onRefreshConfig }: {
    workspace: string;
    config: ProjectWikiConfig;
    activePath: string | null;
    onOpenFile: (path: string) => void;
    onOpenFiles: (path: string) => void;
    onOpenExternal: (path: string) => void;
    onBeforeMutation?: () => Promise<() => void>;
    onRefreshConfig: () => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);
  let disposed = false;
  let exporting = $state(false);
  const diagnostics = createDiagnosticLogger(() => ({ workspace }));
  // The project-level owner keeps scanning while the panel is closed; an
  // isolated tree (tests, previews) owns a private scan for its lifetime.
  const shared = getContext<WikiConsistencyOwner | undefined>(WIKI_CONSISTENCY_CONTEXT);
  const consistency = shared ?? createWikiConsistencyTreeState({
    workspace: () => workspace,
    wikiPath: () => config.path,
    reportError: (cause) => diagnostics.report(cause, "wiki:consistency-status-failed"),
  });
  const operations = createProjectExplorerOperations();
  const projectPath = (path: string) => path ? `${config.path}/${path}` : config.path;
  // Red rows get a native context menu that opens Wiki Conflicts for that branch.
  // Other rows keep the window-wide desktop context menu.
  const conflictsNavigation = getContext<WikiConflictsNavigation | undefined>(WIKI_CONFLICTS_NAVIGATION_CONTEXT);
  const conflictMenu = conflictsNavigation && isTauri() ? createProjectExplorerNativeMenu({
    prepare: async () => {},
    items: (entry) => {
      const branch = projectPath(entry.path);
      return wikiTreeConflictMenuActions(branch, wikiBranchReportLanguage(consistency.findings().findings, branch), (input) => conflictsNavigation.open(input));
    },
    reportError: (cause) => diagnostics.report(cause, "wiki:tree-menu-failed"),
  }) : null;
  function openConflictMenu(event: MouseEvent, entry: ProjectTreeEntry): void {
    if (!conflictMenu) return;
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget as HTMLElement;
    treeState.focusedPath = entry.path;
    row.focus({ preventScroll: true });
    const rect = row.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    void conflictMenu.show(entry, keyboard ? { x: rect.left + 12, y: rect.bottom } : { x: event.clientX, y: event.clientY }, () => !disposed && row.isConnected);
  }
  const navigation = createProjectWikiNavigation({
    workspace: () => workspace,
    config: () => config,
    exists: (targetWorkspace, path) => invoke<boolean>("project_file_exists", { workspace: targetWorkspace, path }),
    onOpenFile: (path) => onOpenFile(path),
    onMissingIndex: (path) => onOpenFile(projectPath(path)),
    onError: (cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
      diagnostics.report(cause, "wiki:index-open-failed");
    },
  });
  function openFile(path: string): void {
    treeState.selectedPath = wikiIndexOwner(path, config) ?? path;
    treeState.selectedPaths = treeState.selectedPath ? [treeState.selectedPath] : [];
    navigation.openFile(path);
  }
  function relativeEntry(entry: ProjectTreeEntry, directory = config.path): ProjectTreeEntry {
    if (!entry.path.startsWith(`${directory}/`)) throw new Error("Wiki listing returned a file outside its folder.");
    return { ...entry, path: entry.path.slice(directory.length + 1) };
  }
  const tree = createProjectExplorerTreeController({
    workspace: () => `${workspace}/${config.path}`,
    refreshKey: () => 0,
    root: () => root,
    onListDirectory: async (path) => {
      const directory = config.path;
      const entries = await invoke<ProjectTreeEntry[]>("list_project_directory", { workspace, path: projectPath(path) });
      return entries.map((entry) => relativeEntry(entry, directory))
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.kind !== "file" || wikiIndexOwner(entry.path, config) === null)
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      });
    },
    onOpenFile: openFile,
    onOpenExternal: (path) => onOpenExternal(projectPath(path)),
    onHealthChange: (message) => {
      if (message && message !== error) diagnostics.report(new Error(message), "wiki:list-failed");
      error = message;
    },
    onLoadExpandedDirectories: async () => [],
    onPersistExpandedDirectories: async () => {},
    clearDrag: () => {},
  });
  const treeState = tree.state;
  const rows = $derived(tree.rows);
  const nameEditor = createProjectExplorerNameEditor({
    workspace: () => `${workspace}/${config.path}`,
    operations,
    tree,
    prepare: () => { error = null; navigation.cancel(); },
    focusPathForEntry: (entry) => entry.kind === "file" ? wikiIndexOwner(entry.path, config) ?? entry.path : entry.path,
    invoke: async (command, args) => {
      const targetWorkspace = workspace, directory = config.path;
      const current = () => !disposed && workspace === targetWorkspace && config.path === directory;
      const release = await onBeforeMutation?.();
      try {
        if (!current()) throw new Error("Wiki changed before the file operation started.");
        const name = String(args.name);
        const pageName = args.kind === "file" && !/\.(?:md|markdown)$/iu.test(name) ? `${name}.md` : name;
        const result = await invoke<ProjectTreeEntry>(command, {
          ...args, workspace: targetWorkspace,
          parent: args.parent ? `${directory}/${String(args.parent)}` : directory,
          ...(args.path ? { path: `${directory}/${String(args.path)}` } : {}),
          name: pageName,
        });
        return relativeEntry(result, directory);
      } finally { release?.(); }
    },
    onOpenFile: openFile,
    onError: (cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
      diagnostics.report(cause, "wiki:create-failed");
    },
    onSuccess: () => {},
    onFinish: () => {},
  });
  const nameState = nameEditor.state;

  $effect(() => {
    const target = workspace, path = config.path;
    untrack(() => shared ? shared.observeConfig(target, path) : consistency.refresh());
  });

  $effect(() => {
    let path: string | null = null;
    if (activePath === config.path) path = "";
    else if (activePath?.startsWith(`${config.path}/`)) path = activePath.slice(config.path.length + 1);
    const selected = path === null ? null : wikiIndexOwner(path, config) ?? path;
    untrack(() => {
      navigation.cancel();
      treeState.selectedPath = selected;
      treeState.selectedPaths = selected ? [selected] : [];
    });
  });

  export function create(kind: "new-file" | "new-directory"): void {
    const selected = rows.find((row) => row.entry.path === treeState.focusedPath)?.entry ?? rows[0]?.entry;
    if (selected) nameEditor.open(kind, selected);
  }
  export async function exportHtml(): Promise<void> {
    if (exporting) return;
    exporting = true;
    error = null;
    try {
      await invoke("export_project_wiki_html", { workspace, path: config.path, index: config.index });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      diagnostics.report(cause, "wiki:html-export-failed");
    } finally { exporting = false; }
  }
  export function showInFiles(): void { onOpenFiles(config.path); }
  export function refresh(): void { consistency.refresh(); void tree.refreshVisibleDirectories(); onRefreshConfig(); }
  export function cancelNavigation(): void { navigation.cancel(); }
  function activate(entry: ProjectTreeEntry): void {
    error = null;
    treeState.focusedPath = entry.path;
    if (entry.kind === "directory") {
      treeState.selectedPath = entry.path;
      treeState.selectedPaths = entry.path ? [entry.path] : [];
      void navigation.openDirectory(entry.path);
    }
    else tree.openFile(entry.path);
  }
  function handleKeydown(event: KeyboardEvent, index: number, entry: ProjectTreeEntry): void {
    if (event.target !== event.currentTarget || event.isComposing) return;
    if ((event.key === " " || (event.key === "Enter" && !event.shiftKey)) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      activate(entry);
    } else {
      navigation.cancel();
      tree.handleKeydown(event, index, entry);
    }
  }
  function toggleDirectory(event: MouseEvent, entry: ProjectTreeEntry): void {
    event.stopPropagation();
    navigation.cancel();
    treeState.focusedPath = entry.path;
    (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-project-tree-path]")?.focus();
    tree.toggleDirectory(entry.path);
  }
  function label(entry: ProjectTreeEntry): string {
    if (!entry.path) return "Contents";
    return entry.kind === "file" ? entry.name.replace(/\.(?:md|markdown)$/iu, "") : entry.name;
  }
  onMount(() => createProjectFilesRefresh(() => {
    // The shared owner has its own periodic refresh.
    if (!shared) consistency.refresh();
    return tree.refreshVisibleDirectories();
  }).dispose);
  onDestroy(() => { disposed = true; conflictMenu?.dispose(); if (!shared) consistency.dispose(); navigation.dispose(); nameEditor.dispose(); operations.invalidate(); tree.dispose(); });
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  <div bind:this={root} class="min-h-0 min-w-0 flex-1 overflow-auto py-1" role="tree" aria-label="Wiki contents" data-wiki-tree>
    {#each rows as row, index (row.entry.path)}
      {@const entry = row.entry}
      {@const expanded = entry.kind === "directory" && tree.isDirectoryExpanded(entry.path)}
      {@const checkSummary = entry.kind === "directory" || /\.(?:md|markdown)$/iu.test(entry.path) ? consistency.summary(entry.path) : undefined}
      {@const indexSummary = entry.kind === "directory" ? consistency.summary(entry.path ? `${entry.path}/${config.index}` : config.index) : undefined}
      {@const indexDescription = indexSummary?.documents === 1 && indexSummary.status === "unknown" ? ` У страницы раздела ${config.index} нет актуальной успешной проверки.` : ""}
      {@const checkDescription = checkSummary ? wikiConsistencyDescription(checkSummary, entry.kind) + indexDescription : ""}
      {@const checkColor = checkSummary?.status === "conflicts" ? "text-tool-error" : checkSummary?.status === "clear" ? "text-tool-success" : ""}
      <div
        role="treeitem"
        class={["flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", treeState.selectedPath === entry.path ? "bg-panel-selected text-foreground" : "text-muted-foreground"]}
        style:padding-left={`${4 + row.depth * 14}px`}
        aria-label={checkDescription ? `${label(entry)}. ${checkDescription}` : label(entry)}
        aria-level={row.depth + 1}
        aria-expanded={entry.kind === "directory" ? expanded : undefined}
        aria-selected={treeState.selectedPath === entry.path}
        tabindex={!nameState.edit && tree.tabbablePath === entry.path ? 0 : -1}
        data-project-tree-path={entry.path}
        data-wiki-consistency={checkSummary?.status}
        title={checkDescription ? `${projectPath(entry.path)}\n${checkDescription}` : projectPath(entry.path)}
        onfocus={() => treeState.focusedPath = entry.path}
        onclick={() => activate(entry)}
        onkeydown={(event) => handleKeydown(event, index, entry)}
        oncontextmenu={checkSummary?.status === "conflicts" && conflictMenu ? (event) => openConflictMenu(event, entry) : undefined}
      >
        {#if entry.kind === "directory"}
          <button type="button" tabindex="-1" class={iconButtonClass("sm", "panel", { extra: "shrink-0" })}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${label(entry)}`}
            aria-expanded={expanded} title={expanded ? "Collapse section" : "Expand section"}
            onclick={(event) => toggleDirectory(event, entry)}>
            <ChevronRight class={["h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", expanded ? "rotate-90" : ""]} aria-hidden="true" />
          </button>
          <Folder class={["h-3.5 w-3.5 shrink-0", checkColor]} aria-hidden="true" />
        {:else}
          <span class="w-6 shrink-0" aria-hidden="true"></span>
          {#if /\.(?:md|markdown)$/iu.test(entry.path)}<FileText class={["h-3.5 w-3.5 shrink-0", checkColor]} aria-hidden="true" />
          {:else if /\.(?:png|jpe?g|gif|webp|svg|avif)$/iu.test(entry.path)}<ImageIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {:else}<File class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{/if}
        {/if}
        <span class={["min-w-0 flex-1 truncate", checkColor]}>{label(entry)}</span>
        {#if checkSummary && checkSummary.status !== "conflicts" && checkSummary.accepted > 0}
          <!-- Neutral marker: accepted/deferred conflicts are neither red nor green. -->
          <CirclePause class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" data-wiki-accepted />
        {/if}
      </div>
      {#if nameState.edit && nameState.edit.parent === entry.path && expanded}
        {#key nameState.edit}
          <ProjectExplorerNameInput edit={nameState.edit} depth={row.depth + 1} onSubmit={() => { if (nameState.edit) void nameEditor.submit(nameState.edit); }} onCancel={(restore) => nameEditor.cancel(nameState.edit, restore)} />
        {/key}
      {/if}
    {/each}
    {#if tree.rootLoading && tree.rootEntries.length === 0}<p class={emptyStateClass} role="status">Loading Wiki…</p>{/if}
    {#if !tree.rootLoading && tree.rootEntries.length === 0 && !error && !nameState.edit}<p class={emptyStateClass}>Add pages or sections to organize your Wiki.</p>{/if}
  </div>
  {#if operations.active.length}<p class="border-t border-border px-3 py-2 text-xs text-muted-foreground" role="status">Creating…</p>{/if}
  {#if error}<p class="border-t border-border px-3 py-2 text-xs text-tool-error" role="alert">{error}</p>{/if}
</div>
