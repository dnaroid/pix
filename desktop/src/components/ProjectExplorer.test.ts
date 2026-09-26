import { describe, expect, it } from "vitest";
import explorerSource from "./ProjectExplorer.svelte?raw";
import menuControllerSource from "./project-explorer-menu-controller.svelte.ts?raw";
import treeControllerSource from "./project-explorer-tree-controller.svelte.ts?raw";

describe("ProjectExplorer keyboard tree", () => {
  it("uses tree semantics with one roving tab stop", () => {
    expect(explorerSource).toContain('role="tree"');
    expect(explorerSource).toContain('role="treeitem"');
    expect(explorerSource).toContain("tabindex={tabbablePath === entry.path ? 0 : -1}");
    expect(explorerSource).toContain("aria-level={row.depth + 1}");
  });

  it("supports IDE tree navigation and a keyboard route to the external editor", () => {
    expect(treeControllerSource).toContain('event.key === "ArrowRight"');
    expect(treeControllerSource).toContain('event.key === "ArrowLeft"');
    expect(treeControllerSource).toContain("projectTreeParentIndex(visibleRows, index)");
    expect(explorerSource).toContain('aria-keyshortcuts="Shift+Enter F2 Delete"');
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
