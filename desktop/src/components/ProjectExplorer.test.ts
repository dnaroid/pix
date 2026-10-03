import { describe, expect, it } from "vitest";
import explorerSource from "./ProjectExplorer.svelte?raw";
import menuControllerSource from "./project-explorer-menu-controller.svelte.ts?raw";
import treeControllerSource from "./project-explorer-tree-controller.svelte.ts?raw";

describe("ProjectExplorer keyboard tree", () => {
  it("polls only visible directory listings through the mounted explorer lifecycle", () => {
    expect(explorerSource).toContain("onMount(() => createProjectFilesRefresh(() => treeController.refreshVisibleDirectories()).dispose)");
    expect(treeControllerSource).toContain("async function refreshVisibleDirectories(): Promise<void>");
    expect(treeControllerSource).toContain('["", ...visibleExpandedDirectories()].map((path) => loadDirectory(path, requestGeneration))');
    expect(treeControllerSource).toContain("(!force && state.loadingDirectories.includes(path))");
  });
  it("exposes a default-expanded workspace root without persisting or mutating it", () => {
    expect(treeControllerSource).toContain("rootExpanded: true");
    expect(treeControllerSource).toContain("state.rootExpanded = true;");
    expect(treeControllerSource).toContain('if (!path) {');
    expect(treeControllerSource).toContain('if (!state.rootExpanded) state.focusedPath = ""');
    expect(treeControllerSource).toContain('state.focusedPath !== null && visiblePaths.has(state.focusedPath)');
    expect(explorerSource).toContain('$derived(projectTreeRootEntry(workspace))');
    expect(explorerSource).toContain('treeController.isDirectoryExpanded(entry.path)');
    expect(explorerSource).toContain('if (entry.path) openNameDialog("rename", entry)');
    expect(explorerSource).toContain('if (entry.path) void deleteEntry(entry)');
    expect(explorerSource).toContain('if (entry.path) dragController.start(event, entry)');
    expect(explorerSource).toContain('event.key === "ContextMenu"');
    expect(explorerSource).toContain('event.shiftKey && event.key === "F10"');
    expect(explorerSource).toContain('treeController.ensureDirectoryExpanded(parent)');
  });
  it("checks ignore eligibility asynchronously and refreshes Git after a guarded mutation", () => {
    expect(explorerSource).toContain('invoke<boolean>("git_can_ignore"');
    expect(explorerSource).toContain('return ignoreEligibility.invalidate');
    expect(explorerSource).toContain('ignoreEligibility.request(workspace, menuState.entry?.path ?? "")');
    expect(explorerSource).toContain('if (canIgnoreEntry) items.push({ label: "Add to .gitignore", disabled: operationBusy })');
    expect(explorerSource).toContain('{#if canIgnoreEntry}');
    expect(explorerSource).toContain('invoke("git_ignore_entry"');
    expect(explorerSource).toContain('operation !== operationGeneration || workspace !== requestWorkspace');
    expect(explorerSource).toContain('void gitRefresh.request()');
  });
  it("uses shared Git snapshots for accessible decorations without changing tab stops", () => {
    expect(explorerSource).toContain("projectGitDecorations(gitSnapshot?.changes)");
    expect(explorerSource).toContain("gitDecorations.directories : gitDecorations.files");
    expect(explorerSource).toContain('data-project-git-status={gitDecoration?.code}');
    expect(explorerSource).toContain('"min-w-0 flex-1 truncate", gitDecoration?.color');
    expect(explorerSource).not.toContain('>{gitDecoration.code}</span>');
    expect(explorerSource).toContain('aria-label={gitDecoration ?');
    expect(explorerSource).toContain('onfocus={() => void gitRefresh.request()}');
    expect(explorerSource).toContain('gitRefresh.dispose()');
  });
  it("uses tree semantics with one roving tab stop", () => {
    expect(explorerSource).toContain('role="tree"');
    expect(explorerSource).toContain('role="treeitem"');
    expect(explorerSource).toContain("tabindex={tabbablePath === entry.path ? 0 : -1}");
    expect(explorerSource).toContain("aria-level={row.depth + 1}");
  });

  it("does not paint restored focus as a second hovered row after deletion", () => {
    expect(explorerSource).toContain("if (focusTarget !== undefined && focusTarget !== null) await treeController.focusPath(focusTarget)");
    expect(explorerSource).toContain("onfocus={() => treeState.focusedPath = entry.path}");
    expect(explorerSource).toContain("hover:bg-panel-hover");
    expect(explorerSource).not.toContain("focus-within:bg-panel-hover");
    expect(explorerSource).toContain('treeState.selectedPath === entry.path ? "bg-panel-selected" : ""');
    expect(explorerSource).toContain("focus-visible:outline-ring");
    expect(explorerSource).toContain("group-focus-within:opacity-100");
  });

  it("supports IDE tree navigation and a keyboard route to the external editor", () => {
    expect(treeControllerSource).toContain('event.key === "ArrowRight"');
    expect(treeControllerSource).toContain('event.key === "ArrowLeft"');
    expect(treeControllerSource).toContain("projectTreeParentIndex(visibleRows, index)");
    expect(explorerSource).toContain('aria-keyshortcuts={entry.path ? "Shift+Enter F2 Delete" : "Shift+Enter"}');
    expect(treeControllerSource).toContain("typeaheadFocusIndex");
  });

  it("exposes IDE-style file commands through pointer and keyboard-reachable context actions", () => {
    expect(explorerSource).toContain("oncontextmenu={(event) => openEntryContextMenu(event, entry)}");
    expect(explorerSource).toContain("data-project-explorer-menu");
    expect(explorerSource).toContain('event.key === "F2"');
    expect(explorerSource).toContain('event.key === "Delete"');
    expect(explorerSource).toContain('primaryShortcut(event, "c")');
    expect(explorerSource).toContain('primaryShortcut(event, "v")');
    expect(explorerSource).toContain("New File…");
    expect(explorerSource).toContain("New Folder…");
    expect(explorerSource).toContain("Duplicate");
    expect(explorerSource).toContain("Copy Relative Path");
    expect(explorerSource).toContain('{ label: "Copy Absolute Path" }');
    expect(explorerSource).toContain('onclick={() => void copyPath(menuEntry, true)}');
    expect(explorerSource).toContain('projectTreeAbsolutePath(requestWorkspace, entry.path)');
    expect(explorerSource).toContain('await writeText(path)');
    expect(explorerSource).toContain('"Reveal in Finder"');
    expect(explorerSource).toContain('"Show in File Explorer"');
    expect(explorerSource).toContain('"Show in File Manager"');
    expect(explorerSource).toContain('items.push({ label: revealLabel })');
    expect(explorerSource).toContain('onclick={() => void revealEntry(menuEntry)}');
    expect(explorerSource).toContain('invoke("reveal_project_entry", { workspace: requestWorkspace, path: entry.path || null })');
    expect(menuControllerSource).toContain("menuFocusIndex");
    expect(menuControllerSource).toContain('event.key === "Escape"');
    expect(menuControllerSource).toContain('event.key === "Tab"');
  });

  it("routes filesystem mutations through workspace-scoped Tauri commands", () => {
    expect(explorerSource).toContain('invoke<ProjectTreeEntry>("create_project_entry"');
    expect(explorerSource).toContain('invoke<ProjectTreeEntry>("rename_project_entry"');
    expect(explorerSource).toContain('invoke<ProjectTreeEntry>("copy_project_entry"');
    expect(explorerSource).toContain('invoke("delete_project_entry"');
    expect(explorerSource).toContain("window.confirm");
    expect(explorerSource).toContain("operationGeneration");
    expect(explorerSource).toContain("finishOperation(operation)");
  });

  it("keeps dotfiles and dotfolders visible but visually muted", () => {
    expect(explorerSource).not.toContain('filter((entry) => !entry.name.startsWith("."))');
    expect(explorerSource).toContain('entry.name.startsWith(".")');
    expect(explorerSource).toContain("opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100");
  });

  it("restores sparse project expansion state from workspace.jsonc and refreshes only visible expanded branches", () => {
    expect(treeControllerSource).toContain("const workspaceChanged = currentWorkspace !== observedWorkspace");
    expect(treeControllerSource).toContain("if (!workspaceChanged && !refreshChanged) return");
    expect(treeControllerSource).toContain("void restoreExpandedDirectories(currentWorkspace, nextGeneration, restoreRevision)");
    expect(treeControllerSource).toContain('return workspaceChanged ? [""] : ["", ...visibleExpandedDirectories()]');
    expect(treeControllerSource).toContain("schedulePersistExpandedDirectories();");
    expect(treeControllerSource).toContain("window.setTimeout(flushExpandedDirectoriesPersist, 300)");
    expect(treeControllerSource).toContain("pruneMissingExpandedChildren(path, entries)");
    expect(treeControllerSource).toContain("if (workspaceChanged) {");
    expect(explorerSource).toContain("WORKSPACE_CONFIG_PATH");
    expect(explorerSource).toContain('invoke<ProjectFilePreview>("read_project_file"');
    expect(explorerSource).toContain('"write_project_workspace_config_if_unchanged"');
    expect(explorerSource).toContain("workspaceConfigWithProjectExplorerExpandedDirectories");
  });

  it("invalidates stale directory requests and preserves tree state across rename/delete", () => {
    expect(treeControllerSource).toContain("directoryRequestVersions");
    expect(treeControllerSource).toContain("directoryRequestVersions.get(path) !== requestVersion");
    expect(treeControllerSource).toContain("async function refreshDirectory(path: string)");
    expect(treeControllerSource).toContain("function remapPath(oldPath: string, newPath: string)");
    expect(treeControllerSource).toContain("function focusFallbackAfterRemoval(path: string)");
    expect(treeControllerSource).toContain("function removePath(path: string)");
  });

  it("searches file paths and contents across the project without expanding the lazy tree", () => {
    expect(explorerSource).toContain('placeholder="Search project files"');
    expect(explorerSource).toContain('invoke<ProjectSearchMatch[]>("search_project_files"');
    expect(explorerSource).toContain("event.shiftKey");
    expect(explorerSource).toContain('event.key.toLocaleLowerCase() === "f"');
    expect(explorerSource).toContain("data-project-search-results");
    expect(explorerSource).toContain("openSearchResult(result)");
    expect(explorerSource).toContain("{ startLine: result.line, endLine: result.line }");
    expect(explorerSource).toContain("Showing the first 500 matches.");
  });
});
