import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import type { ProjectFilePreview } from "../lib/project-files";
import { PROJECT_TODO_PATH } from "../lib/project-documents";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
const confirmation = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../lib/confirm-deletion", () => ({ confirmDesktopDeletion: confirmation.confirm }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let previewId = 1;
  const afterSave = vi.fn();
  const store = createProjectDocumentsStore({
    workspace: () => "/project", openProjectFile: vi.fn(), showEmptyFile: vi.fn(),
    previewId: () => previewId, afterSave, clearError: vi.fn(), reportError: vi.fn(),
  });
  return { store, afterSave, navigate: () => { previewId += 1; } };
}

describe("project file writes", () => {
  beforeEach(() => { tauri.invoke.mockReset(); });

  it("waits for pending writes and blocks new saves until every file-mutation reservation is released", async () => {
    const { store } = fixture();
    const started = deferred<void>();
    const write = deferred<ProjectFilePreview>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "write_project_file") { started.resolve(); return write.promise; }
      return Promise.resolve({ plans: [] });
    });
    const saving = store.save("file.txt", "content");
    await started.promise;
    let ready = false;
    const preparation = store.prepareFileMutation().then((release) => { ready = true; return release; });
    expect(await store.save("other.txt", "blocked")).toBe(false);
    expect(ready).toBe(false);
    write.resolve({ path: "file.txt", content: "content" });
    await saving;
    const releaseOne = await preparation;
    const releaseTwo = await store.prepareFileMutation();
    releaseOne(); releaseOne();
    expect(await store.save("other.txt", "blocked")).toBe(false);
    releaseTwo();
    tauri.invoke.mockResolvedValue({ path: "other.txt", content: "okay" });
    expect(await store.save("other.txt", "okay")).toBe(true);
  });

  it("serializes writes to the same file and captures the originating preview", async () => {
    const entered = deferred<void>();
    const release = deferred<ProjectFilePreview>();
    const { store, afterSave, navigate } = fixture();
    let count = 0;
    tauri.invoke.mockImplementation((command: string, args: { path: string; content: string }) => {
      if (command !== "write_project_markdown") return Promise.resolve({});
      count += 1;
      if (count === 1) { entered.resolve(); return release.promise; }
      return Promise.resolve({ path: args.path, content: args.content });
    });
    const first = store.save(PROJECT_TODO_PATH, "first");
    navigate();
    const second = store.save(PROJECT_TODO_PATH, "second");
    await entered.promise;
    expect(count).toBe(1);
    release.resolve({ path: PROJECT_TODO_PATH, content: "first" });
    await Promise.all([first, second]);
    expect(count).toBe(2);
    expect(afterSave.mock.calls.map((call) => [call[0].content, call[2]])).toEqual([["first", 1], ["second", 2]]);
  });

  it("does not apply a late write after resetting and returning to the same workspace", async () => {
    const entered = deferred<void>();
    const release = deferred<ProjectFilePreview>();
    tauri.invoke.mockImplementation(() => { entered.resolve(); return release.promise; });
    const { store, afterSave } = fixture();
    const saving = store.save(PROJECT_TODO_PATH, "old");
    await entered.promise;
    store.reset();
    release.resolve({ path: PROJECT_TODO_PATH, content: "old" });
    expect(await saving).toBe(false);
    expect(afterSave).not.toHaveBeenCalled();
  });

  it("uses the confined generic writer for ordinary project text files", async () => {
    tauri.invoke.mockImplementation(async (_command: string, args: { path: string; content: string }) => ({
      path: args.path,
      content: args.content,
    }));
    const { store } = fixture();

    expect(await store.save("src/main.ts", "export const ready = true;\n")).toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("write_project_file", {
      workspace: "/project",
      path: "src/main.ts",
      content: "export const ready = true;\n",
    });
  });

  it("passes the loaded workspace snapshot and chains the canonical result for queued saves", async () => {
    const path = ".pi/workspace.jsonc", expected: string[] = [];
    const first = deferred<ProjectFilePreview>(), entered = deferred<void>();
    let count = 0;
    tauri.invoke.mockImplementation((command: string, args: { expectedContent: string; content: string }) => {
      if (command !== "write_project_file") return Promise.resolve({});
      expected.push(args.expectedContent);
      if (++count === 1) { entered.resolve(); return first.promise; }
      return Promise.resolve({ path, content: args.content });
    });
    const store = createProjectDocumentsStore({
      workspace: () => "/project", openProjectFile: vi.fn(), showEmptyFile: vi.fn(), previewId: () => 1,
      currentFile: () => ({ path, content: "loaded" }), afterSave: vi.fn(), clearError: vi.fn(), reportError: vi.fn(),
    });
    const a = store.save(path, "draft-one"), b = store.save(path, "draft-two");
    await entered.promise;
    first.resolve({ path, content: "canonical-with-nonce" });
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(expected).toEqual(["loaded", "canonical-with-nonce"]);
  });

  it("keeps TODO and plan writes on their specialized project-document command", async () => {
    tauri.invoke.mockImplementation(async (_command: string, args: { path: string; content: string }) => ({
      path: args.path,
      content: args.content,
    }));
    const { store } = fixture();

    expect(await store.save(PROJECT_TODO_PATH, "todo\n")).toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("write_project_markdown", expect.objectContaining({
      path: PROJECT_TODO_PATH,
    }));
  });
});

describe("plan progress refresh", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("updates progress from the native snapshot and ignores a late response after reset", async () => {
    const { store } = fixture();
    const path = ".pi/plans/release.md";
    tauri.invoke.mockResolvedValue({ plans: [path], todoExists: false, planProgress: { [path]: { completed: 1, total: 3 } } });
    await store.refresh();
    expect(store.snapshot.planProgress?.[path]).toEqual({ completed: 1, total: 3 });
    const pending = deferred<unknown>();
    tauri.invoke.mockReturnValue(pending.promise);
    const refreshing = store.refresh();
    store.reset();
    pending.resolve({ plans: [path], todoExists: false, planProgress: { [path]: { completed: 3, total: 3 } } });
    await refreshing;
    expect(store.snapshot.plans).toEqual([]);
    expect(store.snapshot.planProgress).toEqual({});
  });
});

describe("confirmed plan deletion", () => {
  const path = ".pi/plans/release.md";
  function deletionFixture() {
    let workspace = "/project";
    const afterDelete = vi.fn();
    const reportError = vi.fn();
    const store = createProjectDocumentsStore({
      workspace: () => workspace, openProjectFile: vi.fn(), showEmptyFile: vi.fn(),
      previewId: () => 1, afterSave: vi.fn(), afterDelete, clearError: vi.fn(), reportError,
    });
    return { store, afterDelete, reportError, changeWorkspace: () => { workspace = "/other"; } };
  }

  beforeEach(() => {
    confirmation.confirm.mockReset().mockResolvedValue(true);
    tauri.invoke.mockReset().mockImplementation(async (command) => command === "list_project_documents"
      ? { plans: [path], todoExists: true } : undefined);
  });

  it("confirms the full path, deletes only that file, updates Preview and reloads documents", async () => {
    const { store, afterDelete } = deletionFixture();
    await store.load("/project");
    tauri.invoke.mockImplementation(async (command) => command === "list_project_documents" ? { plans: [], todoExists: true } : undefined);
    await store.removePlan(path);
    expect(confirmation.confirm).toHaveBeenCalledWith(expect.stringContaining(path), { title: "Delete plan?", okLabel: "Delete" });
    expect(tauri.invoke).toHaveBeenCalledWith("delete_project_entry", { workspace: "/project", path });
    expect(afterDelete).toHaveBeenCalledWith(path, "/project");
    expect(store.snapshot).toEqual({ plans: [], todoExists: true });
    expect(store.removing).toBeNull();
  });

  it.each(["cancel", "workspace", "reset"])("does not delete after %s during confirmation", async (reason) => {
    const { store, changeWorkspace, afterDelete } = deletionFixture();
    await store.load("/project");
    const answer = deferred<boolean>();
    confirmation.confirm.mockReturnValue(answer.promise);
    const deleting = store.removePlan(path);
    if (reason === "workspace") changeWorkspace();
    if (reason === "reset") store.reset();
    answer.resolve(reason !== "cancel");
    await deleting;
    expect(tauri.invoke).not.toHaveBeenCalledWith("delete_project_entry", expect.anything());
    expect(afterDelete).not.toHaveBeenCalled();
  });

  it("rejects noncanonical paths and duplicate delete clicks", async () => {
    const { store } = deletionFixture();
    await store.load("/project");
    await store.removePlan("README.md");
    expect(confirmation.confirm).not.toHaveBeenCalled();
    const answer = deferred<boolean>();
    confirmation.confirm.mockReturnValue(answer.promise);
    const deleting = store.removePlan(path);
    await store.removePlan(path);
    expect(confirmation.confirm).toHaveBeenCalledOnce();
    answer.resolve(false);
    await deleting;
  });

  it("waits for an existing save and blocks new saves until deletion completes", async () => {
    const { store } = deletionFixture();
    await store.load("/project");
    const entered = deferred<void>();
    const saved = deferred<ProjectFilePreview>();
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "write_project_markdown") { entered.resolve(); return saved.promise; }
      if (command === "list_project_documents") return { plans: [], todoExists: true };
    });
    const saving = store.save(path, "before delete");
    await entered.promise;
    const deleting = store.removePlan(path);
    await Promise.resolve();
    expect(await store.save(path, "must not recreate")).toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalledWith("delete_project_entry", expect.anything());
    saved.resolve({ path, content: "before delete" });
    await Promise.all([saving, deleting]);
    expect(tauri.invoke).toHaveBeenCalledWith("delete_project_entry", { workspace: "/project", path });
  });

  it("does not apply a late deletion completion after reset", async () => {
    const { store, afterDelete } = deletionFixture();
    await store.load("/project");
    const entered = deferred<void>();
    const removed = deferred<void>();
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "delete_project_entry") { entered.resolve(); return removed.promise; }
      return { plans: [path], todoExists: true };
    });
    const deleting = store.removePlan(path);
    await entered.promise;
    store.reset();
    await store.load("/project");
    removed.resolve();
    await deleting;
    expect(afterDelete).not.toHaveBeenCalled();
    expect(store.snapshot.plans).toEqual([path]);
  });

  it("preserves the list on deletion failure and reports the error", async () => {
    const { store, afterDelete, reportError } = deletionFixture();
    await store.load("/project");
    const error = new Error("permission denied");
    tauri.invoke.mockRejectedValue(error);
    await store.removePlan(path);
    expect(store.snapshot.plans).toEqual([path]);
    expect(afterDelete).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(error);
    expect(store.removing).toBeNull();
  });
});
