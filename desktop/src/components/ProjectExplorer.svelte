<script lang="ts">
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
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
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import FolderSearch from "@lucide/svelte/icons/folder-search";
  import ImageIcon from "@lucide/svelte/icons/image";
  import Pencil from "@lucide/svelte/icons/pencil";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Search from "@lucide/svelte/icons/search";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import type { MenuNavigationItem } from "../lib/keyboard-navigation";
  import { canOpenProjectEntryInBrowser, projectExplorerMenuActions, type ProjectExplorerMenuAction } from "../lib/project-explorer-native-menu";
  import type { GitSnapshot } from "../lib/git";
  import { projectGitDecorations } from "../lib/project-git-decorations";
  import { createProjectGitRefresh } from "../lib/project-git-refresh";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";
  import { createProjectGitIgnoreEligibility } from "../lib/project-git-ignore";
  import {
    projectExplorerExpandedDirectoriesFromWorkspaceConfig,
    workspaceConfigWithProjectExplorerExpandedDirectories,
  } from "../lib/project-explorer-expansion";
  import { WORKSPACE_CONFIG_PATH } from "../lib/project-colors";
  import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
  import { projectTreeAbsolutePath, projectTreeRootEntry, type ProjectSearchMatch, type ProjectTreeEntry } from "../lib/project-tree";
  import { createProjectExplorerDragController } from "./project-explorer-drag-controller.svelte";
  import { createProjectExplorerMenuController } from "./project-explorer-menu-controller.svelte";
  import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";
  import { createProjectExplorerOperations, type ProjectOperation, type ProjectOperationClaim } from "./project-explorer-operations.svelte";

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
  } = $props();

  let treeRoot = $state<HTMLDivElement | null>(null);
  let nameDialogElement = $state<HTMLDialogElement | null>(null);
  let nameInputElement = $state<HTMLInputElement | null>(null);
  const operations = createProjectExplorerOperations();
  let operationError = $state<string | null>(null);
  let canIgnoreEntry = $state(false);
  let searchInputElement = $state<HTMLInputElement | null>(null);
  let searchQuery = $state("");
  let searchResults = $state<ProjectSearchMatch[]>([]);
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);
  let entryClipboard = $state<ProjectEntryClipboard | null>(null);
  const clipboardReader = createProjectEntryClipboardReader(readText);
  let operationGeneration = 0;
  let searchGeneration = 0;
  let expansionSaveTail: Promise<void> = Promise.resolve();
  let observedOperationWorkspace: string | undefined;
  let nameDialog = $state<{
    mode: "rename" | "new-file" | "new-directory";
    entry: ProjectTreeEntry;
    value: string;
    error: string | null;
  } | null>(null);
  const dragController = createProjectExplorerDragController();
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
  export async function revealPath(path: string): Promise<void> {
    searchQuery = "";
    await treeController.revealPath(path);
  }
  onMount(() => createProjectFilesRefresh(() => treeController.refreshVisibleDirectories()).dispose);
  const rootEntries = $derived(treeController.rootEntries);
  const rows = $derived(treeController.rows);
  const gitDecorations = $derived(projectGitDecorations(gitSnapshot?.changes));
  const gitRefresh = createProjectGitRefresh(async () => {
    if (workspace && onGitStatusRefresh) await onGitStatusRefresh();
  });
  $effect(() => {
    // Read only lifecycle inputs, not the snapshot updated by the request.
    workspace;
    refreshKey;
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
        await Promise.all([refreshEntryClipboard(entry), ignoreEligibility.request(workspace, entry.path)]);
      },
      reportError: (error) => { operationError = errorMessage(error); },
    } : undefined,
    onClose: () => { clipboardReader.invalidate(); ignoreEligibility.invalidate(); },
  });
  onMount(menuController.installNativeCancellation);
  const menuState = menuController.state;
  const ignoreEligibility = createProjectGitIgnoreEligibility(
    (workspace, path) => invoke<boolean>("git_can_ignore", { workspace, path }),
    (allowed) => { canIgnoreEntry = allowed; },
  );

  $effect(() => {
    // OS menus snapshot eligibility before popup, rather than changing while open.
    if (nativeMenus) return;
    // A fresh snapshot may change tracked/ignored eligibility while the DOM menu is open.
    gitSnapshot;
    void ignoreEligibility.request(workspace, menuState.entry?.path ?? "");
    return ignoreEligibility.invalidate;
  });

  onDestroy(() => {
    operationGeneration += 1;
    operations.invalidate();
    clipboardReader.invalidate();
    ignoreEligibility.invalidate();
    gitRefresh.dispose();
    treeController.dispose();
    dragController.clear();
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
    operationError = null;
    searchGeneration += 1;
    searchQuery = "";
    searchResults = [];
    searchLoading = false;
    searchError = null;
    entryClipboard = null;
    clipboardReader.invalidate();
    nameDialogElement?.close();
    nameDialog = null;
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
    const requestWorkspace = workspace;
    const generation = ++searchGeneration;
    searchError = null;
    if (!query || !requestWorkspace) {
      searchResults = [];
      searchLoading = false;
      return;
    }
    searchLoading = true;
    const timer = window.setTimeout(() => {
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
    return () => window.clearTimeout(timer);
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

  function parentDirectory(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
  }

  function destinationDirectory(entry: ProjectTreeEntry): string {
    return entry.kind === "directory" ? entry.path : parentDirectory(entry.path);
  }

  function sameOrDescendantPath(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
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
    items.push({ label: revealLabel });
    if (entry.kind === "directory") {
      items.push({ label: "New File…", disabled: !canCreateIn(entry) }, { label: "New Folder…", disabled: !canCreateIn(entry) });
    }
    if (entry.path) items.push({ label: "Copy" });
    items.push({ label: "Paste", disabled: !canPasteInto(entry) });
    if (entry.path) {
      items.push(
        { label: "Duplicate", disabled: !canDuplicate(entry) },
        { label: "Rename…", disabled: !canMutate(entry) },
        { label: "Copy Relative Path" },
        { label: "Copy Absolute Path" },
      );
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
      "New File…": () => openNameDialog("new-file", entry),
      "New Folder…": () => openNameDialog("new-directory", entry),
      "Copy": () => copyEntry(entry),
      "Paste": () => pasteEntry(entry),
      "Duplicate": () => duplicateEntry(entry),
      "Rename…": () => openNameDialog("rename", entry),
      "Copy Relative Path": () => copyPath(entry),
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
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openEntryContextMenu(new MouseEvent("contextmenu"), entry);
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F2") {
      event.preventDefault();
      if (entry.path) openNameDialog("rename", entry);
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

  async function copyEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path) return;
    menuController.close(true);
    clipboardReader.invalidate();
    const requestWorkspace = workspace;
    const operation = operations.begin(`Copy reference: ${entry.name}`, []);
    if (!operation) return;
    const text = encodeProjectEntryClipboard(requestWorkspace, entry);
    try {
      await writeText(text);
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      entryClipboard = decodeProjectEntryClipboard(text);
      clearOperationError();
    } catch (error) {
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      finishOperation(operation);
    }
  }

  async function copyPath(entry: ProjectTreeEntry, absolute = false): Promise<void> {
    if (!entry.path) return;
    const requestWorkspace = workspace;
    const generation = operationGeneration;
    const path = absolute ? projectTreeAbsolutePath(requestWorkspace, entry.path) : entry.path;
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
    let operation: ProjectOperation | null = null;
    try {
      // Read again at activation: another app/instance may have replaced the clipboard.
      const copied = decodeProjectEntryClipboard(await readText());
      if (generation !== operationGeneration || workspace !== requestWorkspace) return;
      entryClipboard = copied;
      if (!canPasteProjectEntry(copied, requestWorkspace, destination) || !copied) return;
      const claims: ProjectOperationClaim[] = [{ path: destination, kind: "tree" }];
      if (copied.workspace === requestWorkspace) claims.push({ path: copied.path, kind: "tree" });
      operation = operations.begin(`Paste: ${copied.path}`, claims);
      if (!operation) return;
      const created = await invoke<ProjectTreeEntry>("copy_project_entry", {
        workspace: requestWorkspace,
        sourceWorkspace: copied.workspace,
        path: copied.path,
        destination: destination || null,
      });
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      treeController.ensureDirectoryExpanded(destination);
      await treeController.refreshDirectory(destination);
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      await treeController.focusPath(created.path);
      if (operations.isCurrent(operation) && workspace === requestWorkspace) clearOperationError();
    } catch (error) {
      if (generation === operationGeneration && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      if (operation) finishOperation(operation);
    }
  }

  async function duplicateEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path) return;
    menuController.close();
    const requestWorkspace = workspace;
    const destination = parentDirectory(entry.path);
    const operation = operations.begin(`Duplicate: ${entry.name}`, copyClaims(entry.path, destination));
    if (!operation) return;
    try {
      const created = await invoke<ProjectTreeEntry>("copy_project_entry", {
        workspace: requestWorkspace,
        path: entry.path,
        destination: destination || null,
      });
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      await treeController.refreshDirectory(destination);
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      await treeController.focusPath(created.path);
      if (operations.isCurrent(operation) && workspace === requestWorkspace) clearOperationError();
    } catch (error) {
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      finishOperation(operation);
    }
  }

  async function deleteEntry(entry: ProjectTreeEntry): Promise<void> {
    if (!entry.path || !canMutate(entry)) return;
    menuController.close();
    const kind = entry.kind === "directory" ? "folder" : "file";
    if (!window.confirm(`Delete ${kind} “${entry.name}”?\n\nThis cannot be undone.`)) return;
    const requestWorkspace = workspace;
    const parent = parentDirectory(entry.path);
    const fallback = treeController.focusFallbackAfterRemoval(entry.path);
    const operation = operations.begin(`Delete: ${entry.name}`, [{ path: entry.path, kind: "tree" }]);
    if (!operation) return;
    try {
      await invoke("delete_project_entry", { workspace: requestWorkspace, path: entry.path });
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      const restoreFocus = treeState.focusedPath === entry.path || treeState.focusedPath?.startsWith(`${entry.path}/`);
      treeController.removePath(entry.path);
      await treeController.refreshDirectory(parent);
      if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
      const focusTarget = fallback ?? treeController.rows[0]?.entry.path;
      if (restoreFocus && treeState.focusedPath === null && focusTarget !== undefined && focusTarget !== null) await treeController.focusPath(focusTarget);
      if (operations.isCurrent(operation) && workspace === requestWorkspace) clearOperationError();
    } catch (error) {
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      finishOperation(operation);
    }
  }

  function openNameDialog(mode: "rename" | "new-file" | "new-directory", entry: ProjectTreeEntry): void {
    if (mode === "rename" ? !canMutate(entry) : !canCreateIn(entry)) return;
    menuController.close();
    nameDialog = { mode, entry, value: mode === "rename" ? entry.name : "", error: null };
    const dialog = nameDialog;
    void tick().then(() => {
      if (nameDialog !== dialog) return;
      nameDialogElement?.showModal();
      nameInputElement?.focus();
      if (mode === "rename") nameInputElement?.select();
    });
  }

  function closeNameDialog(): void {
    nameDialogElement?.close();
    nameDialog = null;
  }

  async function submitNameDialog(): Promise<void> {
    const dialog = nameDialog;
    if (!dialog) return;
    const name = dialog.value.trim();
    if (!name) {
      dialog.error = "Enter a file or folder name.";
      return;
    }
    const requestWorkspace = workspace;
    const parent = dialog.mode === "rename" ? parentDirectory(dialog.entry.path) : destinationDirectory(dialog.entry);
    const target = parent ? `${parent}/${name}` : name;
    const claims: ProjectOperationClaim[] = dialog.mode === "rename"
      ? [{ path: dialog.entry.path, kind: "tree" }, { path: target, kind: "tree" }]
      : [{ path: parent, kind: "directory" }, { path: target, kind: "tree" }];
    const operation = operations.begin(`${dialog.mode === "rename" ? "Rename" : "Create"}: ${name}`, claims);
    if (!operation) {
      dialog.error = "Another operation is using this path.";
      return;
    }
    dialog.error = null;
    // The decision is resolved. Do not hold the workbench modal while I/O runs.
    closeNameDialog();
    try {
      if (dialog.mode === "rename") {
        const oldPath = dialog.entry.path;
        const selectedBefore = treeState.selectedPath;
        const renamed = await invoke<ProjectTreeEntry>("rename_project_entry", {
          workspace: requestWorkspace,
          path: oldPath,
          name,
        });
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        treeController.remapPath(oldPath, renamed.path);
        await treeController.refreshDirectory(parentDirectory(renamed.path));
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        await treeController.focusPath(renamed.path);
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        if (selectedBefore && sameOrDescendantPath(selectedBefore, oldPath) && treeState.selectedPath) {
          onOpenFile(treeState.selectedPath);
        }
      } else {
        const parent = destinationDirectory(dialog.entry);
        const created = await invoke<ProjectTreeEntry>("create_project_entry", {
          workspace: requestWorkspace,
          parent: parent || null,
          name,
          kind: dialog.mode === "new-file" ? "file" : "directory",
        });
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        treeController.ensureDirectoryExpanded(parent);
        await treeController.refreshDirectory(parent);
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        await treeController.focusPath(created.path);
        if (!operations.isCurrent(operation) || workspace !== requestWorkspace) return;
        if (created.kind === "file") treeController.openFile(created.path);
      }
      if (operations.isCurrent(operation) && workspace === requestWorkspace) clearOperationError();
    } catch (error) {
      if (operations.isCurrent(operation) && workspace === requestWorkspace) operationError = errorMessage(error);
    } finally {
      finishOperation(operation);
    }
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

  function handleWindowKeydown(event: KeyboardEvent): void {
    const primary = isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
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

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Project files">
  <div class="border-b border-sidebar-border px-2 py-1.5">
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
        <div class="px-3 py-8 text-center text-xs text-muted-foreground">No matches found.</div>
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
    class="min-h-0 flex-1 overflow-auto py-1"
    role="tree"
    aria-label="Project files"
    tabindex="-1"
    oncontextmenu={openRootContextMenu}
  >
      {#each rows as row, index (row.entry.path)}
        {@const entry = row.entry}
        {@const gitDecoration = (entry.kind === "directory" ? gitDecorations.directories : gitDecorations.files).get(entry.path)}
        {@const hiddenEntry = entry.path !== "" && entry.name.startsWith(".")}
        {@const expanded = entry.kind === "directory" && treeController.isDirectoryExpanded(entry.path)}
        {@const directoryLoading = entry.kind === "directory" && treeState.loadingDirectories.includes(entry.path)}
        <div
          class={[
            "group flex h-7 w-full min-w-max items-center pr-1 hover:bg-panel-hover",
            treeState.selectedPath === entry.path ? "bg-panel-selected" : "",
          ]}
          style:padding-left={`${4 + row.depth * 14}px`}
          role="presentation"
        >
          <button
            class={[
              "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-xs text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              hiddenEntry && treeState.selectedPath !== entry.path
                ? "opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                : "",
            ]}
            type="button"
            role="treeitem"
            title={`${entry.path || workspace}${gitDecoration ? ` · ${gitDecoration.label}` : ""} · Shift+Enter opens in ${externalEditorLabel}`}
            aria-label={gitDecoration ? `${entry.name} · ${gitDecoration.label}` : entry.name}
            aria-level={row.depth + 1}
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            aria-selected={treeState.selectedPath === entry.path}
            aria-keyshortcuts={entry.path ? "Shift+Enter F2 Delete" : "Shift+Enter"}
            tabindex={tabbablePath === entry.path ? 0 : -1}
            data-project-tree-path={entry.path}
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
              <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
            {:else}
              <span class="w-4 shrink-0" aria-hidden="true"></span>
              {@const iconKind = fileIconKind(entry.path)}
              {#if iconKind === "text"}<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "code"}<FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else if iconKind === "image"}<ImageIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {:else}<File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
            {/if}
            <span class={["min-w-0 flex-1 truncate", gitDecoration?.color ?? ""]}>{entry.name}</span>
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
      {:else if rootEntries.length === 0}
        <div class="px-3 py-8 text-center text-xs text-muted-foreground">This project folder is empty.</div>
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
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void revealEntry(menuEntry)}>
        <FolderSearch class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{revealLabel}</span>
      </button>

      {#if menuEntry.kind === "directory"}
        <div class="my-1 h-px bg-border" role="separator"></div>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canCreateIn(menuEntry)} onclick={() => openNameDialog("new-file", menuEntry)}>
          <FilePlus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>New File…</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canCreateIn(menuEntry)} onclick={() => openNameDialog("new-directory", menuEntry)}>
          <FolderPlus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>New Folder…</span>
        </button>
      {/if}

      <div class="my-1 h-px bg-border" role="separator"></div>
      {#if menuEntry.path}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyEntry(menuEntry)}>
          <CopyIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Copy</span>
          <span class="ml-auto font-mono text-xs text-muted-foreground">{isMacOS ? "⌘C" : "Ctrl+C"}</span>
        </button>
      {/if}
      <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!pasteEnabled} onclick={() => void pasteEntry(menuEntry)}>
        <ClipboardPaste class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Paste</span>
        <span class="ml-auto font-mono text-xs text-muted-foreground">{isMacOS ? "⌘V" : "Ctrl+V"}</span>
      </button>
      {#if menuEntry.path}
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canDuplicate(menuEntry)} onclick={() => void duplicateEntry(menuEntry)}>
          <CopyIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Duplicate</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" disabled={!canMutate(menuEntry)} onclick={() => openNameDialog("rename", menuEntry)}>
          <Pencil class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Rename…</span>
          <span class="ml-auto font-mono text-xs text-muted-foreground">F2</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyPath(menuEntry)}>
          <ClipboardCopy class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Copy Relative Path</span>
        </button>
        <button class="project-file-menu-item" type="button" role="menuitem" tabindex="-1" onclick={() => void copyPath(menuEntry, true)}>
          <ClipboardCopy class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Copy Absolute Path</span>
        </button>
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
    </div>
  {/if}
</section>

{#if nameDialog}
  <dialog
    bind:this={nameDialogElement}
    class="w-full max-w-md rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-md backdrop:bg-background/70"
    oncancel={() => { nameDialog = null; }}
  >
    <form class="p-4" onsubmit={(event) => { event.preventDefault(); void submitNameDialog(); }}>
      <h2 class="text-sm font-semibold">
        {nameDialog.mode === "rename" ? "Rename" : nameDialog.mode === "new-file" ? "New File" : "New Folder"}
      </h2>
      <p class="mt-1 text-xs text-muted-foreground">
        {nameDialog.mode === "rename"
          ? nameDialog.entry.path
          : `Create in ${destinationDirectory(nameDialog.entry) || "project root"}`}
      </p>
      <label class="mt-3 block text-xs font-medium" for="project-entry-name">Name</label>
      <input
        bind:this={nameInputElement}
        bind:value={nameDialog.value}
        id="project-entry-name"
        class="mt-1 h-8 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none"
        autocomplete="off"
        spellcheck="false"
      />
      {#if nameDialog.error}
        <p class="mt-2 text-xs leading-4 text-tool-error">{nameDialog.error}</p>
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        <button class="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" type="button" onclick={closeNameDialog}>Cancel</button>
        <button class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50" type="submit" disabled={!nameDialog.value.trim()}>
          {nameDialog.mode === "rename" ? "Rename" : "Create"}
        </button>
      </div>
    </form>
  </dialog>
{/if}

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
