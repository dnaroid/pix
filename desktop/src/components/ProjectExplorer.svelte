<script lang="ts">
  import { emptyStateClass } from "../lib/status-text";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import ProjectExplorerNameInput from "./ProjectExplorerNameInput.svelte";
  import { createProjectExplorerNameEditor } from "./project-explorer-name-editor.svelte";
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { readSystemProjectClipboard, writeSystemProjectClipboard } from "../lib/system-project-clipboard";
  import { confirmDesktopDeletion } from "../lib/confirm-deletion";
  import {
    canPasteProjectEntry,
    createProjectEntryClipboardReader,
    decodeProjectEntryClipboard,
    encodeProjectEntryClipboard,
    type ProjectEntryClipboard,
  } from "../lib/project-entry-clipboard";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ClipboardCopy from "@lucide/svelte/icons/clipboard-copy";
  import ClipboardPaste from "@lucide/svelte/icons/clipboard-paste";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import File from "@lucide/svelte/icons/file";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderCog from "@lucide/svelte/icons/folder-cog";
  import FileCog from "@lucide/svelte/icons/file-cog";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import FolderSearch from "@lucide/svelte/icons/folder-search";
  import ImageIcon from "@lucide/svelte/icons/image";
  import Pencil from "@lucide/svelte/icons/pencil";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Search from "@lucide/svelte/icons/search";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Scissors from "@lucide/svelte/icons/scissors";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import X from "@lucide/svelte/icons/x";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import type { MenuNavigationItem } from "../lib/keyboard-navigation";
  import { canOpenProjectEntryInBrowser, projectExplorerMenuActions, type ProjectExplorerMenuAction } from "../lib/project-explorer-native-menu";
  import type { GitSnapshot } from "../lib/git";
  import { projectGitDecorations } from "../lib/project-git-decorations";
  import { projectEntryEmphasis } from "../lib/project-entry-emphasis";
  import { createProjectGitRefresh } from "../lib/project-git-refresh";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";
  import { createProjectGitIgnoreEligibility } from "../lib/project-git-ignore";
  import { createProjectGitRemoteLink, gitRemoteLinkLabel, type GitRemoteEntryLink, type ProjectEntryRemoteLink } from "../lib/project-git-remote-link";
  import { openExternalHref } from "../lib/external-links";
  import {
    projectExplorerExpandedDirectoriesFromWorkspaceConfig,
    workspaceConfigWithProjectExplorerExpandedDirectories,
  } from "../lib/project-explorer-expansion";
  import { WORKSPACE_CONFIG_PATH } from "../lib/project-colors";
  import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
  import { projectTreeAbsolutePath, projectTreeRootEntry, type ProjectSearchMatch, type ProjectTreeEntry } from "../lib/project-tree";
  import { createProjectExplorerDragController } from "./project-explorer-drag-controller.svelte";
  import { installProjectExplorerNativeDrop } from "./project-explorer-native-drop";
  import { startProjectFileDrag } from "../lib/desktop-file-drop";
  import { createProjectExplorerMenuController } from "./project-explorer-menu-controller.svelte";
  import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";
  import { createProjectExplorerOperations, type ProjectOperation, type ProjectOperationClaim } from "./project-explorer-operations.svelte";
  import { createProjectExplorerFileActions, parentDirectory } from "./project-explorer-file-actions";

  let {
    workspace,
    externalEditorLabel,
    refreshKey,
    gitSnapshot,
    onGitStatusRefresh,
    onListDirectory,
    onOpenFile,
    onOpenExternal,
    onHealthChange,
    onBeforeMutation,
  }: {
    workspace: string;
    externalEditorLabel: string;
    refreshKey: number;
    gitSnapshot?: GitSnapshot;
    onGitStatusRefresh?: () => Promise<void>;
    onListDirectory: (path: string) => Promise<ProjectTreeEntry[]>;
    onOpenFile: (path: string, range?: ProjectFileLineRange) => void;
    onOpenExternal: (path: string) => void;
    onHealthChange?: (error: string | null) => void;
    onBeforeMutation?: () => Promise<() => void>;
  } = $props();

  let treeRoot = $state<HTMLDivElement | null>(null);
  let filePanel: HTMLElement;
  let nativeDropDestination = $state<string | null>(null);
  const operations = createProjectExplorerOperations();
  let operationError = $state<string | null>(null);
  let canIgnoreEntry = $state(false);
  let remoteLink = $state<ProjectEntryRemoteLink | null>(null);
  let searchInputElement = $state<HTMLInputElement | null>(null);
  let searchQuery = $state("");
  let searchResults = $state<ProjectSearchMatch[]>([]);
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);
  let entryClipboard = $state<ProjectEntryClipboard | null>(null);
  const clipboardReader = createProjectEntryClipboardReader(readSystemProjectClipboard, (error) => diagnostics.warn("project-explorer:clipboard-failed", error));
  let operationGeneration = 0;
  let searchGeneration = 0;
  let expansionSaveTail: Promise<void> = Promise.resolve();
  let observedOperationWorkspace: string | undefined;
  const dragController = createProjectExplorerDragController({
    entries: (entry) => {
      if (!treeController.isSelected(entry.path)) treeController.selectEntry(entry.path);
      return treeController.selectedEntries(entry);
    },
    move: (entries, destination) => {
      const paths = entries.filter((entry) => parentDirectory(entry.path) !== destination).map((entry) => entry.path);
      if (paths.length) void runMutation({ type: "move", paths, destination }, "Move");
    },
    native: isTauri() ? async (entries, signal) => {
      const requestWorkspace = workspace;
      const generation = operationGeneration;
      try {
        await startProjectFileDrag(requestWorkspace, entries.map((entry) => entry.path), signal);
        if (workspace === requestWorkspace && generation === operationGeneration) {
          await treeController.refreshVisibleDirectories();
          void gitRefresh.request();
        }
      } catch (error) {
        diagnostics.warn("project-explorer:drag-failed", error);
        if (workspace === requestWorkspace && generation === operationGeneration) operationError = errorMessage(error);
      }
    } : undefined,
  });
  const treeController = createProjectExplorerTreeController({
    workspace: () => workspace,
    refreshKey: () => refreshKey,
    root: () => treeRoot,
    onListDirectory: (path) => onListDirectory(path),
    onOpenFile: (path) => onOpenFile(path),
    onOpenExternal: (path) => onOpenExternal(path),
    onHealthChange: (error) => onHealthChange?.(error),
    onLoadExpandedDirectories: loadExpandedDirectories,
    onPersistExpandedDirectories: persistExpandedDirectories,
    clearDrag: dragController.clear,
  });
  const treeState = treeController.state;
  const diagnostics = createDiagnosticLogger(() => ({ workspace }));
  const { history, runMutation, replayHistory, canReplay, invokeName } = createProjectExplorerFileActions({
    workspace: () => workspace,
    generation: () => operationGeneration,
    operations,
    tree: treeController,
    prepare: async () => onBeforeMutation ? onBeforeMutation() : () => {},
    closeMenu: () => menuController.close(),
    report: (error, context) => diagnostics.warn(context, error),
    setError: (message) => { operationError = message; },
    finish: finishOperation,
  });
  const nameEditor = createProjectExplorerNameEditor({
    workspace: () => workspace,
    operations,
    tree: treeController,
    prepare: () => { menuController.close(); clearSearch(); },
    invoke: invokeName,
    onOpenFile: (path) => onOpenFile(path),
    onError: (error) => {
      diagnostics.warn("project-explorer:name-operation-failed", error);
      operationError = errorMessage(error);
    },
    onSuccess: () => {}, // The history adapter preserves any recovery warning.
    onFinish: () => { void gitRefresh.request(); },
  });
  const nameState = nameEditor.state;
  export async function revealPath(path: string): Promise<void> {
    searchQuery = "";
    await treeController.revealPath(path);
  }
  onMount(() => createProjectFilesRefresh(
    () => treeController.refreshVisibleDirectories(),
    undefined,
    undefined,
    (error) => diagnostics.warn("project-explorer:files-refresh", error),
  ).dispose);
  onMount(() => installProjectExplorerNativeDrop(filePanel, {
    workspace: () => workspace,
    generation: () => operationGeneration,
    hover: (destination) => { nativeDropDestination = destination; },
    mutate: runMutation,
    report: (error) => diagnostics.warn("project-explorer:drop-failed", error),
    error: (message) => { operationError = message; },
  }));
  const rootEntries = $derived(treeController.rootEntries);
  const rows = $derived(treeController.rows);
  const gitDecorations = $derived(projectGitDecorations(gitSnapshot?.changes));
  const gitRefresh = createProjectGitRefresh(async () => {
    if (workspace && onGitStatusRefresh) await onGitStatusRefresh();
  }, undefined, undefined, (error) => diagnostics.warn("project-explorer:git-refresh", error));
  // A spread sidebar props object invalidates every prop getter when loading
  // changes. Derived values isolate lifecycle inputs from those unrelated writes.
  const refreshTarget = $derived(JSON.stringify([workspace, refreshKey]));
  const effectWorkspace = $derived(workspace);
  const effectGitSnapshot = $derived(gitSnapshot);
  $effect(() => {
    refreshTarget;
    untrack(() => void gitRefresh.request());
  });
  const searchActive = $derived(searchQuery.trim().length > 0);
  const rootLoading = $derived(treeController.rootLoading);
  const rootError = $derived(treeController.rootError);
  const tabbablePath = $derived(treeController.tabbablePath);
  const rootContextEntry = $derived(projectTreeRootEntry(workspace));
  const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const revealLabel = isMacOS ? "Reveal in Finder" : /Windows/.test(navigator.userAgent)
    ? "Show in File Explorer" : "Show in File Manager";
  const nativeMenus = isTauri();
  const menuController = createProjectExplorerMenuController({
    items: menuNavigationItems,
    native: nativeMenus ? {
      items: nativeMenuActions,
      prepare: async (entry) => {
        await Promise.all([
          refreshEntryClipboard(entry),
          ignoreEligibility.request(workspace, entry.path),
          remoteLinks.request(workspace, entry.path),
        ]);
      },
      reportError: (error) => { operationError = errorMessage(error); },
    } : undefined,
    onClose: () => { clipboardReader.invalidate(); ignoreEligibility.invalidate(); remoteLinks.invalidate(); },
  });
  onMount(menuController.installNativeCancellation);
  const menuState = menuController.state;
  const ignoreEligibility = createProjectGitIgnoreEligibility(
    (workspace, path) => invoke<boolean>("git_can_ignore", { workspace, path }),
    (allowed) => { canIgnoreEntry = allowed; },
  );
  const remoteLinks = createProjectGitRemoteLink(
    (workspace, path) => invoke<GitRemoteEntryLink | null>("git_remote_entry_link", { workspace, path }),
    (link) => { remoteLink = link; },
  );

  $effect(() => {
    // OS menus snapshot eligibility before popup, rather than changing while open.
    if (nativeMenus) return;
    // A fresh snapshot may change tracked/ignored eligibility while the DOM menu is open.
    effectGitSnapshot;
    const requestWorkspace = effectWorkspace;
    const path = menuState.entry?.path ?? "";
    untrack(() => void ignoreEligibility.request(requestWorkspace, path));
    return ignoreEligibility.invalidate;
  });
  $effect(() => {
    if (nativeMenus) return;
    // Branch switches arrive through snapshots and change the link's ref.
    effectGitSnapshot;
    const requestWorkspace = effectWorkspace;
    const path = menuState.entry?.path ?? null;
    untrack(() => void remoteLinks.request(requestWorkspace, path));
    return remoteLinks.invalidate;
  });

  onDestroy(() => {
    nameEditor.dispose();
    operationGeneration += 1;
    operations.invalidate();
    history.invalidate();
    clipboardReader.invalidate();
    ignoreEligibility.invalidate();
    remoteLinks.invalidate();
    gitRefresh.dispose();
    treeController.dispose();
    dragController.dispose();
    menuController.dispose();
  });

  $effect(() => {
    const currentWorkspace = workspace;
    if (observedOperationWorkspace === undefined) {
      observedOperationWorkspace = currentWorkspace;
      return;
    }
    if (currentWorkspace === observedOperationWorkspace) return;
    observedOperationWorkspace = currentWorkspace;
    operationGeneration += 1;
    operations.invalidate();
    history.invalidate();
    operationError = null;
    nativeDropDestination = null;
    searchGeneration += 1;
    searchQuery = "";
    searchResults = [];
    searchLoading = false;
    searchError = null;
    entryClipboard = null;
    clipboardReader.invalidate();
    nameEditor.invalidate();
    menuController.close();
  });

  async function loadExpandedDirectories(requestWorkspace: string): Promise<string[]> {
    if (!requestWorkspace) return [];
    try {
      const exists = await invoke<boolean>("project_file_exists", {
        workspace: requestWorkspace,
        path: WORKSPACE_CONFIG_PATH,
      });
      if (!exists) return [];
      const document = await invoke<ProjectFilePreview>("read_project_file", {
        workspace: requestWorkspace,
        path: WORKSPACE_CONFIG_PATH,
      });
      return projectExplorerExpandedDirectoriesFromWorkspaceConfig(document.content);
    } catch (error) {
      console.warn("Could not restore Project Explorer expansion state", error);
      return [];
    }
  }

  async function persistExpandedDirectories(requestWorkspace: string, paths: readonly string[]): Promise<void> {
    const previous = expansionSaveTail;
    let release!: () => void;
    expansionSaveTail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous.catch(() => undefined);
      const exists = await invoke<boolean>("project_file_exists", {
        workspace: requestWorkspace,
        path: WORKSPACE_CONFIG_PATH,
      });
      let current = exists
        ? await invoke<ProjectFilePreview>("read_project_file", {
            workspace: requestWorkspace,
            path: WORKSPACE_CONFIG_PATH,
          })
        : undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const content = workspaceConfigWithProjectExplorerExpandedDirectories(current?.content, paths);
        const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>(
          "write_project_workspace_config_if_unchanged",
          {
            workspace: requestWorkspace,
            expectedContent: current?.content ?? null,
            content,
          },
        );
        if (result.written) return;
        current = result.document ?? undefined;
      }
      throw new Error(".pi/workspace.jsonc changed repeatedly while Project Explorer state was being saved.");
    } catch (error) {
      console.warn("Could not persist Project Explorer expansion state", error);
    } finally {
      release();
    }
  }

  $effect(() => {
    const query = searchQuery.trim();
    const requestWorkspace = effectWorkspace;
    const generation = ++searchGeneration;
    searchError = null;
    if (!query || !requestWorkspace) {
      searchResults = [];
      searchLoading = false;
      return;
    }
    searchLoading = true;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      void invoke<ProjectSearchMatch[]>("search_project_files", {
        workspace: requestWorkspace,
        query,
      }).then((results) => {
        if (
          generation !== searchGeneration
          || workspace !== requestWorkspace
          || searchQuery.trim() !== query
        ) return;
        searchResults = results;
      }).catch((error) => {
        if (
          generation !== searchGeneration
          || workspace !== requestWorkspace
          || searchQuery.trim() !== query
        ) return;
        searchResults = [];
        searchError = errorMessage(error);
      }).finally(() => {
        if (
          generation === searchGeneration
          && workspace === requestWorkspace
          && searchQuery.trim() === query
        ) searchLoading = false;
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      // Stop the native walk too: a cleared query or closed explorer must not
      // keep scanning the project after its result can no longer be shown.
      if (started) {
        void invoke("cancel_search_project_files").catch((error) => {
          diagnostics.warn("project-explorer:search-cancel-failed", error);
        });
      }
    };
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
    treeController.selectEntry(entry.path, event);
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (entry.kind === "directory") treeController.toggleDirectory(entry.path);
    else treeController.openFile(entry.path);
  }


  function destinationDirectory(entry: ProjectTreeEntry): string {
    return entry.kind === "directory" ? entry.path : parentDirectory(entry.path);
  }

  function canPasteInto(entry: ProjectTreeEntry): boolean {
    return operations.canStart([{ path: destinationDirectory(entry), kind: "tree" }])
      && canPasteProjectEntry(entryClipboard, workspace, destinationDirectory(entry));
  }

  function canDuplicate(entry: ProjectTreeEntry): boolean {
    return operations.canStart(copyClaims(entry.path, parentDirectory(entry.path)));
  }

  function copyClaims(source: string, destination: string): ProjectOperationClaim[] {
    // The backend chooses the collision-free output name; protect all possible
    // outputs until it returns, including partially copied entries seen by polling.
    return [{ path: source, kind: "tree" }, { path: destination, kind: "tree" }];
  }

  function canMutate(entry: ProjectTreeEntry): boolean {
    return operations.canStart([{ path: entry.path, kind: "tree" }]);
  }

  function canCreateIn(entry: ProjectTreeEntry): boolean {
    return operations.canStart([{ path: destinationDirectory(entry), kind: "directory" }]);
  }

  function refreshEntryClipboard(entry: ProjectTreeEntry): Promise<void> {
    const requestWorkspace = workspace;
    entryClipboard = null;
    return clipboardReader.refresh((value) => {
      if (workspace === requestWorkspace && menuState.entry?.path === entry.path) entryClipboard = value;
    });
  }

  function menuNavigationItems(entry: ProjectTreeEntry): MenuNavigationItem[] {
    const items: MenuNavigationItem[] = [];
    if (entry.path) items.push({ label: entry.kind === "directory" ? "Toggle Folder" : "Open" });
    items.push({ label: entry.path ? `Open in ${externalEditorLabel}` : `Open Project in ${externalEditorLabel}` });
    if (canOpenProjectEntryInBrowser(entry)) items.push({ label: "Open in Browser" });
    const remote = entryRemoteLink(entry);
    if (remote) items.push({ label: gitRemoteLinkLabel(remote.provider) });
    items.push({ label: revealLabel });
    if (entry.kind === "directory") {
      items.push({ label: "New File…", disabled: !canCreateIn(entry) }, { label: "New Folder…", disabled: !canCreateIn(entry) });
    }
    if (entry.path) items.push({ label: "Copy" });
    if (entry.path) items.push({ label: "Cut", disabled: !canMutate(entry) });
    items.push({ label: "Paste", disabled: !canPasteInto(entry) });
    items.push({ label: "Undo", disabled: !canReplay("undo") }, { label: "Redo", disabled: !canReplay("redo") });
    if (entry.path) {
      items.push(
        { label: "Duplicate", disabled: !canDuplicate(entry) },
        { label: "Rename…", disabled: !canMutate(entry) },
      );
    }
    items.push({ label: entry.path ? "Copy Relative Path" : "Copy Project Name" }, { label: "Copy Absolute Path" });
    if (entry.path) {
      if (canIgnoreEntry) items.push({ label: "Add to .gitignore", disabled: !canIgnore(entry) });
      items.push({ label: "Delete", disabled: !canMutate(entry) });
    }
    return items;
  }

  function nativeMenuActions(entry: ProjectTreeEntry): ProjectExplorerMenuAction[] {
    const commands: Record<string, () => void | Promise<void>> = {
      "Toggle Folder": () => runMenuOpen(entry),
      "Open": () => runMenuOpen(entry),
      "Open in Browser": () => openEntryInBrowser(entry),
      "Open on GitHub": () => openEntryOnRemote(entry),
      "Open on GitLab": () => openEntryOnRemote(entry),
      "New File…": () => nameEditor.open("new-file", entry),
      "New Folder…": () => nameEditor.open("new-directory", entry),
      "Copy": () => copyEntry(entry),
      "Cut": () => copyEntry(entry, true),
      "Paste": () => pasteEntry(entry),
      "Undo": () => replayHistory("undo"),
      "Redo": () => replayHistory("redo"),
      "Duplicate": () => duplicateEntry(entry),
      "Rename…": () => nameEditor.open("rename", entry),
      "Copy Relative Path": () => copyPath(entry),
      "Copy Project Name": () => copyPath(entry),
      "Copy Absolute Path": () => copyPath(entry, true),
      "Add to .gitignore": () => ignoreEntry(entry),
      "Delete": () => deleteEntry(entry),
      [revealLabel]: () => revealEntry(entry),
      [entry.path ? `Open in ${externalEditorLabel}` : `Open Project in ${externalEditorLabel}`]: () => {
        menuController.close();
        onOpenExternal(entry.path);
      },
    };
    return projectExplorerMenuActions(menuNavigationItems(entry), commands, revealLabel, !entry.path);
  }

  function openEntryContextMenu(event: MouseEvent, entry: ProjectTreeEntry): void {
    if (!treeController.isSelected(entry.path)) treeController.selectEntry(entry.path);
    treeState.focusedPath = entry.path;
    menuController.openContextMenu(event, entry);
    if (!nativeMenus) void refreshEntryClipboard(entry);
  }

  function openRootContextMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-project-tree-path]")) return;
    menuController.openContextMenu(event, rootContextEntry);
    if (!nativeMenus) void refreshEntryClipboard(rootContextEntry);
  }

  function primaryShortcut(event: KeyboardEvent, key: string): boolean {
    const primary = isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    return primary && !event.shiftKey && !event.altKey && event.key.toLocaleLowerCase() === key;
  }

  function handleEntryKeydown(event: KeyboardEvent, index: number, entry: ProjectTreeEntry): void {
    const primary = isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (primary && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      void replayHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (primaryShortcut(event, "a")) { event.preventDefault(); treeController.selectAll(); return; }
    if (primaryShortcut(event, "x")) { event.preventDefault(); void copyEntry(entry, true); return; }
    if (event.key === " " && primary && !event.altKey) { event.preventDefault(); treeController.selectEntry(entry.path, { metaKey: true }); return; }
    if (event.key === "Escape") { treeState.selectedPaths = []; return; }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openEntryContextMenu(new MouseEvent("contextmenu"), entry);
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F2") {
      event.preventDefault();
      if (entry.path) nameEditor.open("rename", entry);
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "Delete") {
      event.preventDefault();
      if (entry.path) void deleteEntry(entry);
      return;
    }
    if (primaryShortcut(event, "c")) {
      event.preventDefault();
      void copyEntry(entry);
      return;
    }
    if (primaryShortcut(event, "v")) {
      event.preventDefault();
      void pasteEntry(entry);
      return;
    }
    treeController.handleKeydown(event, index, entry);
  }

  function clearOperationError(): void {
    operationError = null;
  }

  function canIgnore(entry: ProjectTreeEntry): boolean {
    return operations.canStart(ignoreClaims(entry));
  }

  function ignoreClaims(entry: ProjectTreeEntry): ProjectOperationClaim[] {
    const claims: ProjectOperationClaim[] = [{ path: entry.path, kind: "directory" }];
    let parent = entry.kind === "directory" ? entry.path : parentDirectory(entry.path);
    while (true) {
      claims.push({ path: parent ? `${parent}/.gitignore` : ".gitignore", kind: "tree" });
      if (!parent) return claims;
      parent = parentDirectory(parent);
    }
  }

  function finishOperation(operation: ProjectOperation): void {
    if (operations.finish(operation)) void gitRefresh.request();
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function copyEntry(entry: ProjectTreeEntry, cut = false): Promise<void> {
    if (!entry.path) return;
    menuController.close(true);
    clipboardReader.invalidate();
    const requestWorkspace = workspace;
    const operation = operations.begin(`Copy reference: ${entry.name}`, []);
    if (!operation) return;
    const text = encodeProjectEntryClipboard(requestWorkspace, entry, treeController.selectedEntries(entry), cut ? "move" : "copy");
    try {
      await writeSystemProjectClipboard(text);
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      entryClipboard = decodeProjectEntryClipboard(text);
      clearOperationError();
    } catch (error) {
      diagnostics.warn("project-explorer:clipboard-failed", error);
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      finishOperation(operation);
    }
  }

  async function copyPath(entry: ProjectTreeEntry, absolute = false): Promise<void> {
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    let path = entry.path || entry.name;
    if (absolute) path = entry.path ? projectTreeAbsolutePath(requestWorkspace, entry.path) : requestWorkspace;
    menuController.close(true);
    try {
      await writeText(path);
      if (workspace === requestWorkspace && generation === operationGeneration) clearOperationError();
    } catch (error) {
      if (workspace === requestWorkspace && generation === operationGeneration) operationError = errorMessage(error);
    }
  }

  async function revealEntry(entry: ProjectTreeEntry): Promise<void> {
    menuController.close(true);
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    try {
      await invoke("reveal_project_entry", { workspace: requestWorkspace, path: entry.path || null });
      if (workspace === requestWorkspace && generation === operationGeneration) clearOperationError();
    } catch (error) {
      if (workspace === requestWorkspace && generation === operationGeneration) operationError = errorMessage(error);
    }
  }

  async function ignoreEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path || !canIgnoreEntry) return;
    menuController.close(true);
    const requestWorkspace = workspace;
    const operation = operations.begin(`Ignore: ${entry.name}`, ignoreClaims(entry));
    if (!operation) return;
    try {
      await invoke("git_ignore_entry", { workspace: requestWorkspace, path: entry.path });
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      // A newly created .gitignore must appear without disturbing expansion/focus.
      await treeController.refreshDirectory("");
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      const parent = parentDirectory(entry.path);
      if (parent) await treeController.refreshDirectory(parent);
      if (operations.isCurrent(operation) && workspace === requestWorkspace) clearOperationError();
    } catch (error) {
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      // The shared Git snapshot recolors the target, ancestors and .gitignore.
      finishOperation(operation);
    }
  }

  async function pasteEntry(entry: ProjectTreeEntry): Promise<void> {
    menuController.close();
    const requestWorkspace = workspace;
    const destination = destinationDirectory(entry);
    const generation = operationGeneration;
    try {
      // Read again at activation: another app/instance may have replaced the clipboard.
      const copied = decodeProjectEntryClipboard(await readSystemProjectClipboard());
      if (generation !== operationGeneration || workspace !== requestWorkspace) return;
      entryClipboard = copied;
      if (!canPasteProjectEntry(copied, requestWorkspace, destination) || !copied) return;
      const paths = (copied.entries ?? [copied]).map((item) => item.path)
        .filter((path) => copied.operation !== "move" || parentDirectory(path) !== destination);
      if (!paths.length) return;
      const result = await runMutation(copied.operation === "move"
        ? { type: "move", paths, destination }
        : { type: "copy", paths, destination, sourceWorkspace: copied.workspace }, "Paste");
      if (result && copied.operation === "move" && generation === operationGeneration) {
        // Consume only our local cut hint; never clobber a newer system clipboard.
        entryClipboard = null;
      }
    } catch (error) {
      diagnostics.warn("project-explorer:paste-failed", error);
      if (generation === operationGeneration && workspace === requestWorkspace) operationError = errorMessage(error);
    }
  }

  async function duplicateEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path) return;
    await runMutation({ type: "copy", paths: treeController.selectedEntries(entry).map((item) => item.path), destination: parentDirectory(entry.path) }, "Duplicate");
  }

  async function deleteEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path || !canMutate(entry)) return;
    menuController.close();
    const entries = treeController.selectedEntries(entry);
    const label = entries.length > 1 ? `${entries.length} selected entries` : `“${entry.name}”`;
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    if (!await confirmDesktopDeletion(`Delete ${label}?\n\nYou can restore this operation with Undo while this Files panel remains open. Recovery data is retained in .pi/file-history.`, {
      title: "Delete entries?", okLabel: "Delete",
    })) return;
    if (workspace !== requestWorkspace || generation !== operationGeneration || !canMutate(entry)) return;
    const fallback = treeController.focusFallbackAfterRemoval(entry.path);
    const result = await runMutation({ type: "delete", paths: entries.map((item) => item.path) }, "Delete");
    if (result && treeState.focusedPath === null && fallback !== null) await treeController.focusPath(fallback);
  }


  function runMenuOpen(entry: ProjectTreeEntry): void {
    menuController.close();
    if (!entry.path) return;
    if (entry.kind === "directory") treeController.toggleDirectory(entry.path);
    else treeController.openFile(entry.path);
  }

  async function openEntryInBrowser(entry: ProjectTreeEntry): Promise<void> {
    menuController.close();
    if (!canOpenProjectEntryInBrowser(entry)) return;
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    try {
      await invoke("open_project_html_in_browser", { workspace: requestWorkspace, path: entry.path });
    } catch (error) {
      if (generation === operationGeneration && workspace === requestWorkspace) operationError = errorMessage(error);
    }
  }

  function entryRemoteLink(entry: ProjectTreeEntry): ProjectEntryRemoteLink | null {
    const link = remoteLink;
    return link && link.workspace === workspace && link.path === entry.path ? link : null;
  }

  async function openEntryOnRemote(entry: ProjectTreeEntry): Promise<void> {
    const link = entryRemoteLink(entry);
    menuController.close();
    if (!link) return;
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    try {
      await openExternalHref(link.url);
    } catch (error) {
      diagnostics.warn("project-explorer:open-remote-failed", error);
      if (generation === operationGeneration && workspace === requestWorkspace) operationError = errorMessage(error);
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && dragController.dragging) { event.preventDefault(); dragController.clear(); return; }
    const target = event.target instanceof Element ? event.target : null;
    const primary = isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!event.defaultPrevented && primary && !event.altKey && event.key.toLowerCase() === "z"
      && target?.closest("[data-project-explorer]") && !target.closest("input, textarea, [contenteditable='true']")) {
      event.preventDefault();
      void replayHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (
      primary
      && event.shiftKey
      && !event.altKey
      && event.key.toLocaleLowerCase() === "f"
    ) {
      event.preventDefault();
      menuController.close();
      searchInputElement?.focus();
      searchInputElement?.select();
      return;
    }
    menuController.handleWindowKeydown(event);
  }

  function clearSearch(): void {
    searchGeneration += 1;
    searchQuery = "";
    searchResults = [];
    searchLoading = false;
    searchError = null;
    void tick().then(() => treeRoot?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus());
  }

  function openSearchResult(result: ProjectSearchMatch): void {
    const range = result.line === undefined
      ? undefined
      : { startLine: result.line, endLine: result.line };
    onOpenFile(result.path, range);
  }
</script>

<svelte:window
  onfocus={() => void gitRefresh.request()}
  onpointerdown={menuController.handleWindowPointerDown}
  onkeydown={handleWindowKeydown}
  onresize={menuController.handleWindowResize}
/>

{#snippet inlineNameInput(depth: number)}
  {#if nameState.edit}
    {@const edit = nameState.edit}
    {#key edit}
      <ProjectExplorerNameInput
        {edit}
        {depth}
        onSubmit={() => void nameEditor.submit(edit)}
        onCancel={(restoreFocus) => nameEditor.cancel(edit, restoreFocus)}
      />
    {/key}
  {/if}
{/snippet}

<section bind:this={filePanel} class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Project files" data-project-explorer data-project-workspace={workspace}>
  <div class="border-b border-sidebar-border px-2 py-1.5">
    <div class="mb-1 flex h-6 items-center gap-1 text-xs text-muted-foreground">
      <span class="min-w-0 flex-1 truncate">{treeState.selectedPaths.length ? `${treeState.selectedPaths.length} selected` : "Files"}</span>
      <button class="grid h-6 w-6 place-items-center rounded-sm hover:bg-accent disabled:opacity-40 focus-visible:outline-1 focus-visible:outline-ring" type="button" disabled={!canReplay("undo")} aria-label="Undo file operation" title="Undo file operation (⌘Z)" onclick={() => void replayHistory("undo")}><Undo2 class="h-3.5 w-3.5" /></button>
      <button class="grid h-6 w-6 place-items-center rounded-sm hover:bg-accent disabled:opacity-40 focus-visible:outline-1 focus-visible:outline-ring" type="button" disabled={!canReplay("redo")} aria-label="Redo file operation" title="Redo file operation (⇧⌘Z)" onclick={() => void replayHistory("redo")}><Redo2 class="h-3.5 w-3.5" /></button>
    </div>
    <div class="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-input bg-panel-strong px-2 focus-within:border-ring">
      {#if searchLoading}
        <RotateCw class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      {:else}
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <input
        bind:this={searchInputElement}
        bind:value={searchQuery}
        class="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        type="search"
        placeholder="Search project files"
        aria-label="Search project files"
        aria-keyshortcuts={isMacOS ? "Meta+Shift+F" : "Control+Shift+F"}
        autocomplete="off"
        spellcheck="false"
        onkeydown={(event) => {
          if (event.key === "Escape" && searchActive) {
            event.preventDefault();
            clearSearch();
          }
        }}
      />
      {#if searchActive}
        <button
          class="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
          type="button"
          aria-label="Clear project search"
          title="Clear project search"
          onclick={clearSearch}
        ><X class="h-3 w-3" aria-hidden="true" /></button>
      {/if}
    </div>
  </div>

  {#if searchActive}
    <div class="min-h-0 flex-1 overflow-auto py-1" data-project-search-results aria-live="polite">
      {#if searchError}
        <div class="mx-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error">
          {searchError}
        </div>
      {:else if searchLoading && searchResults.length === 0}
        <div class="flex items-center justify-center gap-1.5 py-8 text-xs text-muted-foreground">
          <RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Searching project…
        </div>
      {:else if searchResults.length === 0}
        <div class={emptyStateClass}>No matches found.</div>
      {:else}
        {#each searchResults as result, index (`${result.path}:${result.line ?? ""}:${result.column ?? ""}:${index}`)}
          <button
            class="block w-full px-2.5 py-1.5 text-left hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            type="button"
            onclick={() => openSearchResult(result)}
            title={result.line === undefined ? result.path : `${result.path}:${result.line}:${result.column ?? 1}`}
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{result.path}</span>
              {#if result.line !== undefined}
                <span class="shrink-0 font-mono text-xs text-muted-foreground">L{result.line}:{result.column ?? 1}</span>
              {/if}
            </span>
            <span class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{result.preview}</span>
          </button>
        {/each}
        {#if searchResults.length >= 500}
          <div class="px-3 py-2 text-xs text-muted-foreground">Showing the first 500 matches.</div>
        {/if}
      {/if}
    </div>
  {:else}
  <div
    bind:this={treeRoot}
    class={["min-h-0 flex-1 overflow-auto py-1", nativeDropDestination === "" ? "ring-1 ring-inset ring-ring" : ""]}
    role="tree"
    aria-multiselectable="true"
    aria-label="Project files"
    tabindex="-1"
    oncontextmenu={openRootContextMenu}
    data-project-move-target=""
  >
      {#each rows as row, index (row.entry.path)}
        {@const entry = row.entry}
        {@const gitDecoration = (entry.kind === "directory" ? gitDecorations.directories : gitDecorations.files).get(entry.path)}
        {@const emphasis = projectEntryEmphasis(entry)}
        {@const hiddenEntry = entry.path !== "" && entry.name.startsWith(".")}
        {@const expanded = entry.kind === "directory" && treeController.isDirectoryExpanded(entry.path)}
        {@const directoryLoading = entry.kind === "directory" && treeController.isDirectoryLoading(entry.path)}
        {#if nameState.edit?.mode === "rename" && nameState.edit.entry.path === entry.path}
          {@render inlineNameInput(row.depth)}
        {:else}
        <div
          class={[
            "group flex h-7 w-full min-w-max items-center pr-1 hover:bg-panel-hover",
            treeController.isSelected(entry.path) ? "bg-panel-selected" : "",
            (dragController.dragging && dragController.destination === entry.path) || nativeDropDestination === entry.path ? "ring-1 ring-inset ring-ring bg-panel-hover" : "",
          ]}
          style:padding-left={`${4 + row.depth * 14}px`}
          role="presentation"
          data-project-move-row
          data-project-move-target={entry.kind === "directory" ? entry.path : undefined}
        >
          <button
            class={[
              "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-xs text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              hiddenEntry && !emphasis && !treeController.isSelected(entry.path)
                ? "opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                : "",
            ]}
            type="button"
            role="treeitem"
            title={`${entry.path || workspace}${emphasis ? ` · ${emphasis}` : ""}${gitDecoration ? ` · ${gitDecoration.label}` : ""} · Shift+Enter opens in ${externalEditorLabel}`}
            aria-label={gitDecoration ? `${entry.name} · ${gitDecoration.label}` : entry.name}
            aria-level={row.depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={treeController.isSelected(entry.path)}
            aria-keyshortcuts={entry.path ? "Shift+Enter F2 Delete" : "Shift+Enter"}
            tabindex={!nameState.edit && tabbablePath === entry.path ? 0 : -1}
            data-project-tree-path={entry.path}
            data-project-move-target={entry.kind === "directory" ? entry.path : undefined}
            data-project-entry-emphasis={emphasis}
            data-project-git-status={gitDecoration?.code}
            onfocus={() => treeState.focusedPath = entry.path}
            onkeydown={(event) => handleEntryKeydown(event, index, entry)}
            oncontextmenu={(event) => openEntryContextMenu(event, entry)}
            onclick={(event) => activateProjectEntry(event, entry)}
            onpointerdown={(event) => { if (entry.path) dragController.start(event, entry); }}
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
              {#if emphasis}
                <FolderCog class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              {:else}
                <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
              {/if}
            {:else}
              <span class="w-4 shrink-0" aria-hidden="true"></span>
              {@const iconKind = fileIconKind(entry.path)}
              {#if emphasis}<FileCog class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              {:else if iconKind === "text"}<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "code"}<FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "image"}<ImageIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else}<File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
            {/if}
            <span class={["min-w-0 flex-1 truncate", gitDecoration?.color ?? (emphasis ? "text-primary" : ""), emphasis ? "font-medium" : ""]}>{entry.name}</span>
          </button>

          <button
            class="invisible grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground group-hover:visible"
            type="button"
            tabindex="-1"
            aria-hidden="true"
            title={`Open ${entry.name} in ${externalEditorLabel}`}
            onclick={(event) => stopAndOpenExternal(event, entry.path)}
          >
            <ExternalLink class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {/if}
        {#if nameState.edit && nameState.edit.mode !== "rename" && nameState.edit.parent === entry.path && expanded}
          {@render inlineNameInput(row.depth + 1)}
        {/if}
        {#if entry.path && entry.kind === "directory" && expanded && treeState.errorByDirectory[entry.path]}
          <div
            class="pr-2 text-xs leading-4 text-tool-error"
            style:padding-left={`${34 + (row.depth + 1) * 14}px`}
          >{treeState.errorByDirectory[entry.path]}</div>
        {/if}
      {/each}
    {#if treeState.rootExpanded}
      {#if rootLoading && rootEntries.length === 0}
        <div class="flex items-center justify-center gap-1.5 py-8 text-xs text-muted-foreground">
          <RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading project files…
        </div>
      {:else if rootError}
        <div class="mx-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error">{rootError}</div>
      {:else if rootEntries.length === 0 && !nameState.edit}
        <div class={emptyStateClass}>This project folder is empty.</div>
      {/if}
    {/if}
  </div>
  {/if}

  {#if operations.active.length}
    <div class="mx-2 mb-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status" title={operations.active.map((operation) => operation.label).join("\n")}>
      <RotateCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <span class="truncate">{operations.active.length === 1 ? operations.active[0]?.label : `${operations.active.length} file operations running…`}</span>
    </div>
  {/if}

  {#if operationError}
    <div class="mx-2 mb-2 rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error">
      {operationError}
    </div>
  {/if}

  {#if menuState.entry && menuState.position}
    {@const menuEntry = menuState.entry}
    {@const pasteEnabled = canPasteInto(menuEntry)}
    {@const menuRemoteLink = entryRemoteLink(menuEntry)}
    <div
      bind:this={menuState.menuElement}
      use:menuController.observeMenu
      class="fixed z-[100] max-h-[calc(100vh-1rem)] w-56 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={`left: ${menuState.position.left}px; top: ${menuState.position.top}px;`}
      role="menu"
      tabindex="-1"
      aria-label="Project file actions"
      data-project-explorer-menu
      onkeydown={menuController.handleMenuKeydown}
    >
      {#if menuEntry.path}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => runMenuOpen(menuEntry)}>
          <File class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{menuEntry.kind === "directory" ? "Toggle Folder" : "Open"}</span>
        </button>
      {/if}
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => { menuController.close(); onOpenExternal(menuEntry.path); }}>
        <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{menuEntry.path ? `Open in ${externalEditorLabel}` : `Open Project in ${externalEditorLabel}`}</span>
        {#if menuEntry.path}<span class="ml-auto font-mono text-xs text-muted-foreground">⇧Enter</span>{/if}
      </button>
      {#if canOpenProjectEntryInBrowser(menuEntry)}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void openEntryInBrowser(menuEntry)}>
          <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Open in Browser</span>
        </button>
      {/if}
      {#if menuRemoteLink}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void openEntryOnRemote(menuEntry)}>
          <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{gitRemoteLinkLabel(menuRemoteLink.provider)}</span>
        </button>
      {/if}
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void revealEntry(menuEntry)}>
        <FolderSearch class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{revealLabel}</span>
      </button>

      {#if menuEntry.kind === "directory"}
        <div class="my-1 h-px bg-border" role="separator"></div>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canCreateIn(menuEntry)} onclick={() => nameEditor.open("new-file", menuEntry)}>
          <FilePlus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>New File…</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canCreateIn(menuEntry)} onclick={() => nameEditor.open("new-directory", menuEntry)}>
          <FolderPlus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>New Folder…</span>
        </button>
      {/if}

      <div class="my-1 h-px bg-border" role="separator"></div>
      {#if menuEntry.path}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyEntry(menuEntry)}>
          <CopyIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Copy</span>
          <span class="ml-auto font-mono text-xs text-muted-foreground">{isMacOS ? "⌘C" : "Ctrl+C"}</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canMutate(menuEntry)} onclick={() => void copyEntry(menuEntry, true)}>
          <Scissors class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Cut</span>
          <span class="ml-auto font-mono text-xs text-muted-foreground">⌘X</span>
        </button>
      {/if}
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!pasteEnabled} onclick={() => void pasteEntry(menuEntry)}>
        <ClipboardPaste class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Paste</span>
        <span class="ml-auto font-mono text-xs text-muted-foreground">{isMacOS ? "⌘V" : "Ctrl+V"}</span>
      </button>
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canReplay("undo")} onclick={() => void replayHistory("undo")}><Undo2 class="h-3.5 w-3.5" aria-hidden="true" /><span>Undo</span><span class="ml-auto font-mono text-xs text-muted-foreground">⌘Z</span></button>
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canReplay("redo")} onclick={() => void replayHistory("redo")}><Redo2 class="h-3.5 w-3.5" aria-hidden="true" /><span>Redo</span><span class="ml-auto font-mono text-xs text-muted-foreground">⇧⌘Z</span></button>
      {#if menuEntry.path}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canDuplicate(menuEntry)} onclick={() => void duplicateEntry(menuEntry)}>
          <CopyIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Duplicate</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canMutate(menuEntry)} onclick={() => nameEditor.open("rename", menuEntry)}>
          <Pencil class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Rename…</span>
          <span class="ml-auto font-mono text-xs text-muted-foreground">F2</span>
        </button>
      {/if}
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyPath(menuEntry)}>
        <ClipboardCopy class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{menuEntry.path ? "Copy Relative Path" : "Copy Project Name"}</span>
      </button>
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyPath(menuEntry, true)}>
        <ClipboardCopy class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Copy Absolute Path</span>
      </button>
      {#if menuEntry.path}
        {#if canIgnoreEntry}
          <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canIgnore(menuEntry)} onclick={() => void ignoreEntry(menuEntry)}>
            <FileText class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Add to .gitignore</span>
          </button>
        {/if}
        <div class="my-1 h-px bg-border" role="separator"></div>
        <button class="project-file-menu-item text-destructive hover:bg-destructive/10" type="button" role="menuitem" tabindex="-1" disabled={!canMutate(menuEntry)} onclick={() => void deleteEntry(menuEntry)}>
          <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Delete</span>
          <span class="ml-auto font-mono text-xs opacity-65">Delete</span>
        </button>
      {/if}
    </div>
  {/if}

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
      {#if dragController.count > 1}<span class="shrink-0 text-muted-foreground">+{dragController.count - 1}</span>{/if}
    </div>
  {/if}
</section>

<style>
  .project-file-menu-item {
    display: flex;
    min-height: 1.75rem;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.5rem;
    text-align: left;
    font-size: 0.75rem;
    line-height: 1rem;
  }
  .project-file-menu-item:hover { background: var(--accent); }
  .project-file-menu-item:focus-visible {
    outline: 1px solid var(--ring);
    outline-offset: -1px;
  }
  .project-file-menu-item:disabled { cursor: default; opacity: 0.4; }
</style>
