import type { ProjectTreeEntry } from "../lib/project-tree";
import type { createProjectExplorerOperations } from "./project-explorer-operations.svelte";
import type { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";

export type ProjectEntryNameMode = "rename" | "new-file" | "new-directory";
export interface ProjectEntryNameEdit {
  mode: ProjectEntryNameMode;
  entry: ProjectTreeEntry;
  parent: string;
  value: string;
  error: string | null;
}

export function projectEntryNameSelection(edit: ProjectEntryNameEdit): number {
  if (edit.mode !== "rename" || edit.entry.kind === "directory") return edit.value.length;
  const dot = edit.value.lastIndexOf(".");
  return dot > 0 ? dot : edit.value.length;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function createProjectExplorerNameEditor(options: {
  workspace: () => string;
  operations: ReturnType<typeof createProjectExplorerOperations>;
  tree: Pick<ReturnType<typeof createProjectExplorerTreeController>,
    "ensureDirectoryExpanded" | "focusPath" | "remapPath" | "refreshDirectory" | "openFile">
    & { state: { selectedPath: string | null; focusedPath: string | null } };
  prepare: () => void;
  invoke: (command: string, args: Record<string, unknown>) => Promise<ProjectTreeEntry>;
  onOpenFile: (path: string) => void;
  onError: (error: unknown) => void;
  onSuccess: () => void;
  onFinish: () => void;
}) {
  const state = $state({ edit: null as ProjectEntryNameEdit | null });
  let revision = 0;
  let disposed = false;

  function open(mode: ProjectEntryNameMode, entry: ProjectTreeEntry): void {
    if (disposed || (mode === "rename" && !entry.path)) return;
    const parent = mode === "rename" || entry.kind === "file" ? parentDirectory(entry.path) : entry.path;
    const claims = mode === "rename"
      ? [{ path: entry.path, kind: "tree" as const }]
      : [{ path: parent, kind: "directory" as const }];
    if (!options.operations.canStart(claims)) return;
    options.prepare();
    revision++;
    // Invalidate any older focusRow continuation that is awaiting a render.
    options.tree.state.focusedPath = null;
    if (mode !== "rename") options.tree.ensureDirectoryExpanded(parent);
    state.edit = { mode, entry, parent, value: mode === "rename" ? entry.name : "", error: null };
  }

  function cancel(edit = state.edit, restoreFocus = false): void {
    if (!edit || state.edit !== edit) return;
    state.edit = null;
    revision++;
    if (restoreFocus && !disposed) void options.tree.focusPath(edit.entry.path);
  }

  function invalidate(): void {
    state.edit = null;
    revision++;
  }

  async function submit(edit: ProjectEntryNameEdit): Promise<void> {
    if (disposed || state.edit !== edit) return;
    const name = edit.value.trim();
    if (!name || name === "." || name === ".." || /[/\\\u0000]/.test(name)) {
      edit.error = "Enter a file or folder name without path separators.";
      return;
    }
    if (edit.mode === "rename" && name === edit.entry.name) {
      cancel(edit, true);
      return;
    }
    const target = edit.parent ? `${edit.parent}/${name}` : name;
    const claims = edit.mode === "rename"
      ? [{ path: edit.entry.path, kind: "tree" as const }, { path: target, kind: "tree" as const }]
      : [{ path: edit.parent, kind: "directory" as const }, { path: target, kind: "tree" as const }];
    const operation = options.operations.begin(`${edit.mode === "rename" ? "Rename" : "Create"}: ${name}`, claims);
    if (!operation) {
      edit.error = "Another operation is using this path.";
      return;
    }
    const workspace = options.workspace();
    // Release the input before I/O; unrelated tree operations remain available.
    state.edit = null;
    const owner = ++revision;
    const focusedBefore = options.tree.state.focusedPath;
    const current = () => !disposed && options.operations.isCurrent(operation) && options.workspace() === workspace;
    const mayFocus = () => current() && owner === revision && state.edit === null;
    try {
      const selectedBefore = options.tree.state.selectedPath;
      const result = edit.mode === "rename"
        ? await options.invoke("rename_project_entry", { workspace, path: edit.entry.path, name })
        : await options.invoke("create_project_entry", {
            workspace, parent: edit.parent || null, name,
            kind: edit.mode === "new-file" ? "file" : "directory",
          });
      if (!current()) return;
      if (edit.mode === "rename") options.tree.remapPath(edit.entry.path, result.path);
      else options.tree.ensureDirectoryExpanded(edit.parent);
      await options.tree.refreshDirectory(edit.parent);
      if (!current()) return;
      const restoreFocus = mayFocus() && options.tree.state.focusedPath === focusedBefore;
      if (restoreFocus) await options.tree.focusPath(result.path);
      if (!current()) return;
      if (edit.mode === "rename") {
        if (selectedBefore && (selectedBefore === edit.entry.path || selectedBefore.startsWith(`${edit.entry.path}/`))
          && options.tree.state.selectedPath) options.onOpenFile(options.tree.state.selectedPath);
      } else if (result.kind === "file" && restoreFocus && mayFocus()
        && options.tree.state.focusedPath === result.path) options.tree.openFile(result.path);
      options.onSuccess();
    } catch (error) {
      if (current()) options.onError(error);
    } finally {
      if (options.operations.finish(operation)) options.onFinish();
    }
  }

  return { state, open, cancel, submit, invalidate, dispose: () => { disposed = true; invalidate(); } };
}
