import { describe, expect, it, vi } from "vitest";
import type { ProjectTreeEntry } from "../lib/project-tree";
import { createProjectExplorerNameEditor, projectEntryNameSelection } from "./project-explorer-name-editor.svelte";
import { createProjectExplorerOperations } from "./project-explorer-operations.svelte";

const file: ProjectTreeEntry = { path: "src/main.ts", name: "main.ts", kind: "file" };
const folder: ProjectTreeEntry = { path: "src", name: "src", kind: "directory" };
const root: ProjectTreeEntry = { path: "", name: "project", kind: "directory" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let workspace = "/project";
  const operations = createProjectExplorerOperations();
  const tree = {
    state: { selectedPath: null as string | null, focusedPath: null as string | null },
    ensureDirectoryExpanded: vi.fn(),
    focusPath: vi.fn(async (path: string) => { tree.state.focusedPath = path; }),
    refreshDirectory: vi.fn(async (_path: string) => {}),
    remapPath: vi.fn((oldPath: string, newPath: string) => {
      if (tree.state.selectedPath === oldPath) tree.state.selectedPath = newPath;
    }),
    openFile: vi.fn(),
  };
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>): Promise<ProjectTreeEntry> => file);
  const onError = vi.fn();
  const onOpenFile = vi.fn();
  const onSuccess = vi.fn();
  const onFinish = vi.fn();
  const editor = createProjectExplorerNameEditor({
    workspace: () => workspace, operations, tree, invoke, prepare: vi.fn(), onError, onOpenFile, onSuccess, onFinish,
  });
  return { editor, tree, invoke, operations, onError, onOpenFile, onSuccess, onFinish,
    switchWorkspace: (value: string) => { workspace = value; operations.invalidate(); editor.invalidate(); } };
}

describe("Project Explorer inline names", () => {
  it("creates at the root and inside collapsed directories, expanding the parent before typing", async () => {
    const h = harness();
    for (const entry of [root, folder, file]) {
      h.editor.open("new-file", entry);
      const edit = h.editor.state.edit!;
      const parent = entry === root ? "" : "src";
      expect(edit.parent).toBe(parent);
      expect(edit.value).toBe("");
      expect(h.tree.ensureDirectoryExpanded).toHaveBeenLastCalledWith(parent);
      edit.value = "new.ts";
      const result = { ...file, name: "new.ts", path: parent ? `${parent}/new.ts` : "new.ts" };
      h.invoke.mockResolvedValueOnce(result);
      await h.editor.submit(edit);
      expect(h.invoke).toHaveBeenLastCalledWith("create_project_entry", {
        workspace: "/project", parent: parent || null, name: "new.ts", kind: "file",
      });
      expect(h.tree.openFile).toHaveBeenLastCalledWith(result.path);
    }
  });

  it("creates folders without opening them as files", async () => {
    const h = harness();
    h.editor.open("new-directory", root);
    h.editor.state.edit!.value = "src";
    h.invoke.mockResolvedValueOnce(folder);
    await h.editor.submit(h.editor.state.edit!);
    expect(h.invoke).toHaveBeenCalledWith("create_project_entry", { workspace: "/project", parent: null, name: "src", kind: "directory" });
    expect(h.tree.focusPath).toHaveBeenCalledWith("src");
    expect(h.tree.openFile).not.toHaveBeenCalled();
  });

  it.each([
    ["main.ts", "file", 4], ["main.test.ts", "file", 9], [".gitignore", "file", 10],
    ["README", "file", 6], ["my.folder", "directory", 9],
  ] as const)("selects the appropriate part of %s", (name, kind, end) => {
    expect(projectEntryNameSelection({ mode: "rename", entry: { name, path: name, kind }, parent: "", value: name, error: null })).toBe(end);
  });

  it.each(["", " ", ".", "..", "a/b", "a\\b", "a\0b"])("keeps invalid input %j inline without I/O", async (value) => {
    const h = harness();
    h.editor.open("new-file", root);
    const edit = h.editor.state.edit!;
    edit.value = value;
    await h.editor.submit(edit);
    expect(edit.error).toBeTruthy();
    expect(h.editor.state.edit).toBe(edit);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("cancels on Escape with focus restoration, but blur does not steal focus", () => {
    const h = harness();
    h.editor.open("rename", file);
    h.editor.cancel(h.editor.state.edit, true);
    expect(h.tree.focusPath).toHaveBeenCalledWith(file.path);
    h.tree.focusPath.mockClear();
    h.editor.open("new-file", root);
    h.editor.cancel(h.editor.state.edit, false);
    expect(h.editor.state.edit).toBeNull();
    expect(h.tree.focusPath).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("treats unchanged names as cancellation and rejects renaming the root", async () => {
    const h = harness();
    h.editor.open("rename", root);
    expect(h.editor.state.edit).toBeNull();
    h.editor.open("rename", file);
    await h.editor.submit(h.editor.state.edit!);
    expect(h.editor.state.edit).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("renames while preserving selected-file remapping", async () => {
    const h = harness();
    h.tree.state.selectedPath = file.path;
    h.editor.open("rename", file);
    h.editor.state.edit!.value = "renamed.ts";
    h.invoke.mockResolvedValueOnce({ ...file, name: "renamed.ts", path: "src/renamed.ts" });
    await h.editor.submit(h.editor.state.edit!);
    expect(h.tree.remapPath).toHaveBeenCalledWith(file.path, "src/renamed.ts");
    expect(h.onOpenFile).toHaveBeenCalledWith("src/renamed.ts");
    expect(h.onSuccess).toHaveBeenCalledOnce();
    expect(h.operations.active).toHaveLength(0);
  });

  it("rechecks conflicting reservations at submission without removing the input", async () => {
    const h = harness();
    h.editor.open("new-file", folder);
    const edit = h.editor.state.edit!;
    edit.value = "new.ts";
    h.operations.begin("Concurrent rename", [{ path: "src", kind: "tree" }]);
    await h.editor.submit(edit);
    expect(edit.error).toContain("Another operation");
    expect(h.editor.state.edit).toBe(edit);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("releases input before I/O and ignores repeat submits and stale blur callbacks", async () => {
    const h = harness();
    const pending = deferred<ProjectTreeEntry>();
    h.invoke.mockReturnValueOnce(pending.promise);
    h.editor.open("new-file", root);
    const first = h.editor.state.edit!;
    first.value = "first.ts";
    const submitted = h.editor.submit(first);
    expect(h.editor.state.edit).toBeNull();
    expect(h.operations.active).toHaveLength(1);
    await h.editor.submit(first);
    h.editor.open("new-file", folder);
    const second = h.editor.state.edit;
    h.editor.cancel(first);
    expect(h.editor.state.edit).toBe(second);
    pending.resolve({ ...file, path: "first.ts", name: "first.ts" });
    await submitted;
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.tree.focusPath).not.toHaveBeenCalled();
    expect(h.tree.openFile).not.toHaveBeenCalled();
    expect(h.editor.state.edit).toBe(second);
    expect(h.operations.active).toHaveLength(0);
  });

  it.each(["workspace", "dispose"])("ignores stale I/O after %s", async (change) => {
    const h = harness();
    const pending = deferred<ProjectTreeEntry>();
    h.invoke.mockReturnValueOnce(pending.promise);
    h.editor.open("new-file", root);
    h.editor.state.edit!.value = "new.ts";
    const submitted = h.editor.submit(h.editor.state.edit!);
    if (change === "workspace") { h.switchWorkspace("/other"); h.switchWorkspace("/project"); }
    else h.editor.dispose();
    pending.reject(new Error("late failure"));
    await submitted;
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.tree.focusPath).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
  });

  it("does not steal focus or open a created file after the user navigates elsewhere", async () => {
    const h = harness();
    const pending = deferred<ProjectTreeEntry>();
    h.invoke.mockReturnValueOnce(pending.promise);
    h.editor.open("new-file", root);
    h.editor.state.edit!.value = "new.ts";
    const submitted = h.editor.submit(h.editor.state.edit!);
    h.tree.state.focusedPath = "other.ts";
    pending.resolve({ ...file, path: "new.ts", name: "new.ts" });
    await submitted;
    expect(h.tree.refreshDirectory).toHaveBeenCalledWith("");
    expect(h.tree.focusPath).not.toHaveBeenCalled();
    expect(h.tree.openFile).not.toHaveBeenCalled();
  });

  it("does not apply successful completions after the workspace has been replaced", async () => {
    const h = harness();
    const pending = deferred<ProjectTreeEntry>();
    h.invoke.mockReturnValueOnce(pending.promise);
    h.editor.open("rename", file);
    h.editor.state.edit!.value = "other.ts";
    const submitted = h.editor.submit(h.editor.state.edit!);
    h.switchWorkspace("/other");
    pending.resolve({ ...file, path: "src/other.ts", name: "other.ts" });
    await submitted;
    expect(h.tree.remapPath).not.toHaveBeenCalled();
    expect(h.tree.refreshDirectory).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
  });

  it("reports failed mutations and releases their reservation", async () => {
    const h = harness();
    h.editor.open("new-file", root);
    h.editor.state.edit!.value = "exists.ts";
    h.invoke.mockRejectedValueOnce(new Error("Already exists"));
    await h.editor.submit(h.editor.state.edit!);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Already exists" }));
    expect(h.operations.active).toHaveLength(0);
    expect(h.onFinish).toHaveBeenCalledOnce();
  });
});
