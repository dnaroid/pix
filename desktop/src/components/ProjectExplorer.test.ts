import { describe, expect, it } from "vitest";
import explorerSource from "./ProjectExplorer.svelte?raw";
import menuControllerSource from "./project-explorer-menu-controller.svelte.ts?raw";
import treeControllerSource from "./project-explorer-tree-controller.svelte.ts?raw";
import nameEditorSource from "./project-explorer-name-editor.svelte.ts?raw";
import nameInputSource from "./ProjectExplorerNameInput.svelte?raw";
import fileActionsSource from "./project-explorer-file-actions.ts?raw";

describe("ProjectExplorer keyboard tree", () => {
  it("wires both HTML browser menu surfaces to the guarded backend action", () => {
    expect(explorerSource).toContain('if (canOpenProjectEntryInBrowser(entry)) items.push({ label: "Open in Browser" })');
    expect(explorerSource).toContain('"Open in Browser": () => openEntryInBrowser(entry)');
    expect(explorerSource).toContain('{#if canOpenProjectEntryInBrowser(menuEntry)}');
    expect(explorerSource).toContain('onclick={() => void openEntryInBrowser(menuEntry)}');
    expect(explorerSource).toContain('invoke("open_project_html_in_browser", { workspace: requestWorkspace, path: entry.path })');
    expect(explorerSource).toContain('generation === operationGeneration && workspace === requestWorkspace');
  });
  it("uses OS file menus in Desktop and retains DOM navigation only for browser preview", () => {
    expect(explorerSource).toContain("const nativeMenus = isTauri()");
    expect(explorerSource).toContain("native: nativeMenus ?");
    expect(explorerSource).toContain("refreshEntryClipboard(entry),\n          ignoreEligibility.request(workspace, entry.path),\n          remoteLinks.request(workspace, entry.path),\n        ]);");
    expect(explorerSource).toContain("if (!nativeMenus) void refreshEntryClipboard(entry)");
    expect(explorerSource).toContain("if (nativeMenus) return");
  });
  it("measures the menu and bounds its scroll surface to the viewport", () => {
    expect(explorerSource).toContain("use:menuController.observeMenu");
    expect(explorerSource).toContain("max-h-[calc(100vh-1rem)]");
    expect(explorerSource).toContain("max-w-[calc(100vw-1rem)] overflow-y-auto");
    expect(menuControllerSource).not.toContain("MENU_HEIGHT");
  });
  it("polls only visible directory listings through the mounted explorer lifecycle", () => {
    expect(explorerSource).toMatch(/onMount\(\(\) => createProjectFilesRefresh\(\s*\(\) => treeController\.refreshVisibleDirectories\(\),[^;]*project-explorer:files-refresh[^;]*\)\.dispose\)/);
    expect(treeControllerSource).toContain("async function refreshVisibleDirectories(): Promise<void>");
    expect(treeControllerSource).toContain('["", ...visibleExpandedDirectories()].map((path) => loadDirectory(path, requestGeneration, false, true))');
    expect(treeControllerSource).toContain("if (!force && directoryLoads.has(path)) return directoryLoads.get(path)!");
  });
  it("exposes a default-expanded workspace root without persisting or mutating it", () => {
    expect(treeControllerSource).toContain("rootExpanded: true");
    expect(treeControllerSource).toContain("state.rootExpanded = true;");
    expect(treeControllerSource).toContain('if (!path) {');
    expect(treeControllerSource).toContain('state.focusedPath = "";');
    expect(treeControllerSource).toContain('state.focusedPath !== null && visiblePaths.has(state.focusedPath)');
    expect(explorerSource).toContain('$derived(projectTreeRootEntry(workspace))');
    expect(explorerSource).toContain('treeController.isDirectoryExpanded(entry.path)');
    expect(explorerSource).toContain('if (entry.path) nameEditor.open("rename", entry)');
    expect(explorerSource).toContain('if (entry.path) void deleteEntry(entry)');
    expect(explorerSource).toContain('if (entry.path) dragController.start(event, entry)');
    expect(explorerSource).toContain('event.key === "ContextMenu"');
    expect(explorerSource).toContain('event.shiftKey && event.key === "F10"');
    expect(nameEditorSource).toContain('options.tree.ensureDirectoryExpanded(parent)');
  });
  it("checks ignore eligibility asynchronously and refreshes Git after a guarded mutation", () => {
    expect(explorerSource).toContain('invoke<boolean>("git_can_ignore"');
    expect(explorerSource).toContain('return ignoreEligibility.invalidate');
    expect(explorerSource).toContain('untrack(() => void ignoreEligibility.request(requestWorkspace, path))');
    expect(explorerSource).toContain('if (canIgnoreEntry) items.push({ label: "Add to .gitignore", disabled: !canIgnore(entry) })');
    expect(explorerSource).toContain('{#if canIgnoreEntry}');
    expect(explorerSource).toContain('invoke("git_ignore_entry"');
    expect(explorerSource).toContain('!operations.isCurrent(operation) || workspace !== requestWorkspace');
    expect(explorerSource).toContain('void gitRefresh.request()');
  });
  it("offers path copying for the workspace root without enabling root mutations", () => {
    const menuPolicy = explorerSource.slice(
      explorerSource.indexOf("function menuNavigationItems("),
      explorerSource.indexOf("function nativeMenuActions("),
    );
    expect(menuPolicy).toContain('}\n    items.push({ label: entry.path ? "Copy Relative Path" : "Copy Project Name" }, { label: "Copy Absolute Path" });\n    if (entry.path) {');
    const pathCopy = explorerSource.slice(
      explorerSource.indexOf("async function copyPath("),
      explorerSource.indexOf("async function revealEntry("),
    );
    expect(pathCopy).not.toContain("if (!entry.path) return");
    expect(pathCopy).toContain('let path = entry.path || entry.name');
    expect(explorerSource).toContain('"Copy Project Name": () => copyPath(entry)');
    expect(explorerSource).toContain('{menuEntry.path ? "Copy Relative Path" : "Copy Project Name"}');
    expect(pathCopy).toContain('if (absolute) path = entry.path ? projectTreeAbsolutePath(requestWorkspace, entry.path) : requestWorkspace');
    expect(pathCopy).toContain("await writeText(path)");
    expect(explorerSource).toMatch(/\{\/if\}\s*<button[^>]+onclick=\{\(\) => void copyPath\(menuEntry\)\}/u);
    expect(explorerSource).toMatch(/<span>Copy Absolute Path<\/span>\s*<\/button>\s*\{#if menuEntry.path\}/u);
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
    expect(explorerSource).toContain("tabindex={!nameState.edit && tabbablePath === entry.path ? 0 : -1}");
    expect(explorerSource).toContain("aria-level={row.depth + 1}");
  });

  it("does not paint restored focus as a second hovered row after deletion", () => {
    expect(explorerSource).toContain("if (result && treeState.focusedPath === null && fallback !== null) await treeController.focusPath(fallback)");
    expect(explorerSource).toContain("onfocus={() => treeState.focusedPath = entry.path}");
    expect(explorerSource).toContain("hover:bg-panel-hover");
    expect(explorerSource).not.toContain("focus-within:bg-panel-hover");
    expect(explorerSource).toContain('treeController.isSelected(entry.path) ? "bg-panel-selected" : ""');
    expect(explorerSource).toContain('role="presentation"\n          data-project-move-row\n          data-project-move-target={entry.kind === "directory" ? entry.path : undefined}');
    expect(explorerSource).toContain("focus-visible:outline-ring");
  });

  it("shows the external-editor icon only on the pointer-hovered row without a fade-out", () => {
    const externalButton = explorerSource.slice(
      explorerSource.indexOf('class="invisible grid h-6 w-6'),
      explorerSource.indexOf('<ExternalLink class="h-3 w-3"'),
    );
    expect(externalButton).toContain("group-hover:visible");
    expect(externalButton).toContain('tabindex="-1"');
    expect(externalButton).toContain("stopAndOpenExternal(event, entry.path)");
    expect(externalButton).not.toContain("transition-opacity");
    expect(explorerSource).not.toContain("group-focus-within:opacity-100");
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
    expect(nameEditorSource).toContain('options.invoke("create_project_entry"');
    expect(nameEditorSource).toContain('options.invoke("rename_project_entry"');
    expect(fileActionsSource).toContain('history.execute(request)');
    expect(explorerSource).toContain('type: "copy", paths:');
    expect(explorerSource).toContain('type: "delete", paths:');
    expect(explorerSource).toContain("await confirmDesktopDeletion");
    expect(explorerSource).toContain("operationGeneration");
    expect(fileActionsSource).toContain("options.finish(operation)");
  });

  it("uses scoped reservations rather than globally disabling file actions during I/O", () => {
    expect(explorerSource).not.toContain("operationBusy");
    expect(explorerSource).toContain("createProjectExplorerOperations()");
    expect(fileActionsSource).toContain('projectFileRequestClaims(request, options.workspace())');
    expect(fileActionsSource).toContain('operations.begin(label, claims)');
    expect(explorerSource).toContain('disabled={!canMutate(menuEntry)}');
    expect(explorerSource).toContain('role="status"');
    const submit = nameEditorSource.slice(nameEditorSource.indexOf("async function submit"));
    expect(submit.indexOf("state.edit = null;")).toBeLessThan(submit.indexOf('options.invoke("rename_project_entry"'));
  });

  it("edits names in tree rows, without a modal or intercepting text-editing shortcuts", () => {
    expect(explorerSource).not.toContain("<dialog");
    expect(explorerSource).not.toContain("showModal");
    expect(explorerSource).toContain('nameState.edit?.mode === "rename" && nameState.edit.entry.path === entry.path');
    expect(explorerSource).toContain('nameState.edit.parent === entry.path && expanded');
    expect(explorerSource).toContain("inlineNameInput(row.depth + 1)");
    expect(explorerSource).toContain("nameEditor.invalidate()");
    expect(explorerSource).toContain("nameEditor.dispose()");
    expect(nameInputSource).toContain("event.stopPropagation()");
    expect(nameInputSource).toContain("event.isComposing");
    expect(nameInputSource).toContain('event.key === "Enter"');
    expect(nameInputSource).toContain('event.key === "Escape"');
    expect(nameInputSource).toContain("onblur={() => onCancel(false)}");
    expect(nameInputSource).toContain("input.setSelectionRange(0, projectEntryNameSelection(edit))");
    expect(nameInputSource).toContain('role="alert"');
  });

  it("uses shared clipboard references and rechecks at paste activation", () => {
    expect(explorerSource).toContain("encodeProjectEntryClipboard(requestWorkspace, entry, treeController.selectedEntries(entry)");
    expect(explorerSource).toContain("decodeProjectEntryClipboard(await readSystemProjectClipboard())");
    expect(explorerSource).toContain("sourceWorkspace: copied.workspace");
    expect(explorerSource).toContain("refreshEntryClipboard(entry)");
    expect(explorerSource).toContain("clipboardReader.invalidate()");
    expect(explorerSource).not.toContain("copied.workspace !== workspace");
  });

  it("keeps dotfiles and dotfolders visible but visually muted", () => {
    expect(explorerSource).not.toContain('filter((entry) => !entry.name.startsWith("."))');
    expect(explorerSource).toContain('entry.name.startsWith(".")');
    expect(explorerSource).toContain("opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100");
  });

  it("emphasizes Pix entries without muting them or overriding Git name colors", () => {
    expect(explorerSource).toContain("const emphasis = projectEntryEmphasis(entry)");
    expect(explorerSource).toContain("hiddenEntry && !emphasis && !treeController.isSelected(entry.path)");
    expect(explorerSource).toContain('data-project-entry-emphasis={emphasis}');
    expect(explorerSource).toContain('<FolderCog class="h-3.5 w-3.5 shrink-0 text-primary"');
    expect(explorerSource).toContain('<FileCog class="h-3.5 w-3.5 shrink-0 text-primary"');
    expect(explorerSource).toContain('gitDecoration?.color ?? (emphasis ? "text-primary" : "")');
    expect(explorerSource).toContain('emphasis ? "font-medium" : ""');
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
    expect(treeControllerSource).toContain("directoryRequestVersions.get(path) === requestVersion");
    expect(treeControllerSource).toContain("if (!isCurrentRequest()) return;");
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
