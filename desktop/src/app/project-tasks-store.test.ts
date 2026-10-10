import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { createProjectTasksStore } from "./project-tasks.svelte";
import type { ProjectTaskDocument } from "../lib/project-tasks";

const DOCUMENT: ProjectTaskDocument = {
  version: 1,
  tasks: [{
    id: "task-1",
    title: "Sync me",
    type: "feature",
    status: "todo",
    priority: "medium",
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
  }],
};

describe("project task store save hook", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("notifies background sync only after a successful task document write", async () => {
    const afterSave = vi.fn();
    tauri.invoke.mockResolvedValueOnce(undefined);
    const store = createProjectTasksStore({
      workspace: () => "/project",
      afterSave,
      reportError: vi.fn(),
    });

    await expect(store.save(DOCUMENT)).resolves.toBe(true);
    expect(afterSave).toHaveBeenCalledWith("/project");

    tauri.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.save(DOCUMENT)).resolves.toBe(false);
    expect(afterSave).toHaveBeenCalledTimes(1);
  });

  it("persists status-group reordering via a dedicated SQLite mutation and ignores self-drops", async () => {
    const afterSave = vi.fn();
    const store = createProjectTasksStore({ workspace: () => "/project", afterSave, reportError: vi.fn() });
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    tauri.invoke.mockResolvedValueOnce({
      ...DOCUMENT, tasks: [{ ...DOCUMENT.tasks[0], status: "in-progress", updatedAt: new Date().toISOString() }],
    });
    store.reorder("task-1", "in-progress", null, "after");
    await vi.waitFor(() => expect(afterSave).toHaveBeenCalledOnce());
    expect(tauri.invoke).toHaveBeenLastCalledWith("reorder_project_task", expect.objectContaining({
      taskId: "task-1", targetStatus: "in-progress", targetTaskId: null,
      position: "after", expectedTask: DOCUMENT.tasks[0],
    }));
    expect(store.document.tasks[0]?.updatedAt).not.toBe(DOCUMENT.tasks[0]?.updatedAt);
    const callCount = tauri.invoke.mock.calls.length;
    store.reorder("task-1", "done", "task-1", "before");
    expect(tauri.invoke).toHaveBeenCalledTimes(callCount);
  });

  it("passes editor attachments as task-scoped SQLite links and never embeds file paths in the description", async () => {
    const reportError = vi.fn();
    const store = createProjectTasksStore({ workspace: () => "/project", reportError });
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    tauri.invoke.mockResolvedValueOnce(undefined);
    const attachment = {
      id: "attached", name: "screenshot.png", path: "/project/.pi/task-attachments/abc123",
      kind: "image" as const, mimeType: "image/png", size: 32,
    };
    expect(await store.update("task-1", {
      title: "Updated", description: "Clean task description", type: "feature",
      attachments: [attachment],
    })).toBe(true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("write_project_tasks", expect.objectContaining({
      attachments: [{ path: attachment.path, name: attachment.name, size: 32 }],
      document: expect.objectContaining({ tasks: [
        expect.objectContaining({ title: "Updated", description: "Clean task description" }),
      ] }),
      expectedDocument: DOCUMENT,
    }));
    expect(store.document.tasks[0]?.description).not.toContain(attachment.path);
    expect(reportError).not.toHaveBeenCalled();
    tauri.invoke.mockResolvedValueOnce(undefined);
    expect(await store.update("task-1", {
      title: "Updated again", type: "feature", attachments: [],
    })).toBe(true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("write_project_tasks", expect.objectContaining({ attachments: [] }));
  });

  it("updates hierarchy, related tasks, project file links and model on one SQLite row only", async () => {
    const parent = { ...DOCUMENT.tasks[0]!, id: "parent", title: "Epic", epic: true };
    const peer = { ...DOCUMENT.tasks[0]!, id: "peer", title: "Related" };
    const initial = { ...DOCUMENT, tasks: [parent, DOCUMENT.tasks[0]!, peer] };
    const store = createProjectTasksStore({ workspace: () => "/project", reportError: vi.fn() });
    tauri.invoke.mockResolvedValueOnce(initial);
    await store.load("/project");
    tauri.invoke.mockResolvedValueOnce(undefined);
    expect(await store.update("task-1", {
      title: "Linked task", type: "feature", parentId: "parent",
      relatedTaskIds: ["peer"], links: ["docs/specs/parent.md"],
      modelRef: "provider/smart-model:high", epic: false,
    })).toBe(true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("write_project_tasks", expect.objectContaining({
      expectedDocument: initial,
      document: expect.objectContaining({ tasks: [
        parent,
        expect.objectContaining({
          id: "task-1", parentId: "parent", relatedTaskIds: ["peer"],
          links: ["docs/specs/parent.md"], modelRef: "provider/smart-model:high",
        }),
        peer,
      ] }),
    }));
    expect(store.document.tasks[0]).toEqual(parent);
    expect(store.document.tasks[2]).toEqual(peer);
  });

  it("does not save arbitrary unpersisted editor attachments", async () => {
    const reportError = vi.fn();
    const store = createProjectTasksStore({ workspace: () => "/project", reportError });
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    expect(await store.update("task-1", {
      title: "Updated", type: "feature",
      attachments: [{ id: "unpersisted", name: "draft.txt", kind: "file", mimeType: "text/plain" }],
    })).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("persisted to a project-owned file"),
    }));
  });
});

describe("project task loading presentation", () => {
  beforeEach(() => tauri.invoke.mockReset());

  function fixture() {
    let workspace = "/project";
    const reportError = vi.fn();
    const store = createProjectTasksStore({ workspace: () => workspace, reportError });
    return { store, reportError, setWorkspace: (value: string) => { workspace = value; } };
  }

  function pendingRead() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    tauri.invoke.mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
    return { resolve, reject };
  }

  it.each([DOCUMENT, { version: 1, tasks: [] }])("keeps a loaded snapshot visible during repeat reads: %j", async (document) => {
    const { store } = fixture();
    const first = pendingRead();
    const loading = store.load("/project");
    expect(store.initialLoading).toBe(true);
    first.resolve(document);
    await loading;
    expect(store.initialLoading).toBe(false);

    const next = pendingRead();
    const refreshing = store.load("/project");
    expect(store.loading).toBe(true);
    expect(store.initialLoading).toBe(false);
    expect(store.document).toEqual(document);
    next.resolve(DOCUMENT);
    await refreshing;
    expect(store.loading).toBe(false);
    expect(store.document).toEqual(DOCUMENT);
  });

  it("requires a fresh snapshot after workspace changes or reset and ignores stale reads", async () => {
    const { store, setWorkspace } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    const old = pendingRead();
    const stale = store.load("/project");
    setWorkspace("/other");
    const current = pendingRead();
    const loading = store.load("/other");
    expect(store.initialLoading).toBe(true);
    old.resolve(DOCUMENT);
    await stale;
    expect(store.initialLoading).toBe(true);
    current.resolve({ version: 1, tasks: [] });
    await loading;
    expect(store.initialLoading).toBe(false);

    const late = pendingRead();
    const lateRead = store.load("/other");
    store.reset();
    late.resolve(DOCUMENT);
    await lateRead;
    expect(store.document.tasks).toEqual([]);
    const fresh = pendingRead();
    const freshRead = store.load("/other");
    expect(store.initialLoading).toBe(true);
    fresh.resolve(DOCUMENT);
    await freshRead;
  });

  it("still reports repeat read failures without flashing a loading screen", async () => {
    const { store, reportError } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    const next = pendingRead();
    const refreshing = store.load("/project");
    next.reject(new Error("Malformed tasks"));
    await refreshing;
    expect(store.loadFailed).toBe(true);
    expect(store.initialLoading).toBe(false);
    expect(store.document).toEqual(DOCUMENT);
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe("project task live reload and compare-and-save", () => {
  beforeEach(() => { tauri.invoke.mockReset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  function fixture() {
    let workspace = "/project";
    const reportError = vi.fn();
    const store = createProjectTasksStore({ workspace: () => workspace, reportError });
    return { store, reportError, switchWorkspace: () => { workspace = "/other"; store.reset(); } };
  }

  it("picks up external edits, coalesces polls, and owns timer cleanup", async () => {
    const { store } = fixture();
    let disk = DOCUMENT;
    tauri.invoke.mockImplementation(async () => disk);
    await store.load("/project");
    const stop = store.observe();
    await vi.advanceTimersByTimeAsync(0);
    disk = { ...DOCUMENT, tasks: [{ ...DOCUMENT.tasks[0]!, title: "External" }] };
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.document).toEqual(disk);
    expect(store.loading).toBe(false);
    stop();
    const calls = tauri.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(tauri.invoke).toHaveBeenCalledTimes(calls);
  });

  it("creates in the explicitly selected status group and saves priority without losing other fields", async () => {
    const { store } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    tauri.invoke.mockResolvedValue(undefined);
    await expect(store.create({ title: "Idea", type: "idea", status: "backlog" })).resolves.toBe(true);
    expect(store.document.tasks[0]).toMatchObject({ type: "idea", status: "backlog", priority: "medium" });
    const before = store.document.tasks[1];
    if (!before) throw new Error("Existing task missing after create");
    store.updatePriority(before.id, "urgent");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.document.tasks[1]).toMatchObject({ ...before, priority: "urgent", updatedAt: expect.any(String) });
    expect(tauri.invoke.mock.calls.at(-1)).toMatchObject(["write_project_tasks", {
      expectedDocument: { tasks: expect.arrayContaining([before]) },
    }]);
  });

  it("rejects late poll completion after editor pause or workspace reset", async () => {
    const { store, switchWorkspace } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    let finish!: (value: unknown) => void;
    tauri.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const stop = store.observe();
    await vi.advanceTimersByTimeAsync(6000);
    expect(tauri.invoke).toHaveBeenCalledTimes(2); // one in-flight poll, no overlap
    stop(); // editor opens: its baseline must not be replaced by this read
    finish({ version: 1, tasks: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.document).toEqual(DOCUMENT);
    tauri.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const stopNext = store.observe();
    switchWorkspace();
    finish(DOCUMENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.document.tasks).toEqual([]);
    stopNext();
  });

  it("rejects an external write between load and save, reloads disk, and preserves the draft", async () => {
    const { store, reportError } = fixture();
    let disk = DOCUMENT;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "read_project_tasks") return disk;
      if (JSON.stringify(args.expectedDocument) !== JSON.stringify(disk)) throw new Error("Task file conflict: changed externally");
      disk = args.document;
    });
    await store.load("/project");
    const draft = { title: "Local unsaved", type: "feature" as const, expectedTask: DOCUMENT.tasks[0]! };
    disk = { ...DOCUMENT, tasks: [{ ...DOCUMENT.tasks[0]!, title: "External" }] };
    await expect(store.update("task-1", draft)).resolves.toBe(false);
    expect(disk.tasks[0]?.title).toBe("External");
    expect(store.document).toEqual(disk);
    expect(draft.title).toBe("Local unsaved");
    expect(store.saveError).toContain("Task file conflict");
    expect(reportError).toHaveBeenCalledOnce();
    // A blind retry of the old editor baseline is rejected even after reload.
    await expect(store.update("task-1", draft)).resolves.toBe(false);
    await expect(store.update("task-1", { ...draft, expectedTask: disk.tasks[0]! })).resolves.toBe(true);
    expect(disk.tasks[0]?.title).toBe("Local unsaved");
  });

  it("does not let a poll or stale save replace a newer local/workspace snapshot", async () => {
    const { store, switchWorkspace } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    let finishRead!: (value: unknown) => void;
    tauri.invoke.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    const refreshing = store.refresh();
    let finishWrite!: () => void;
    tauri.invoke.mockReturnValueOnce(new Promise<void>((resolve) => { finishWrite = resolve; }));
    const next = { ...DOCUMENT, tasks: [{ ...DOCUMENT.tasks[0]!, title: "Local saved" }] };
    const saving = store.save(next);
    finishRead(DOCUMENT);
    await refreshing;
    expect(store.document).toEqual(next);
    await store.refresh();
    expect(tauri.invoke).toHaveBeenCalledTimes(3);
    switchWorkspace();
    finishWrite();
    await expect(saving).resolves.toBe(false);
    expect(store.document.tasks).toEqual([]);
    expect(store.saving).toBe(false);
  });

  it("preserves nonconflicting external tasks on a reviewed retry of the unchanged editor draft", async () => {
    const { store } = fixture();
    let disk = DOCUMENT;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "read_project_tasks") return disk;
      if (JSON.stringify(args.expectedDocument) !== JSON.stringify(disk)) throw "Task file conflict: changed externally";
      disk = args.document;
    });
    await store.load("/project");
    const external = { ...DOCUMENT.tasks[0]!, id: "external", title: "Another external task" };
    disk = { ...DOCUMENT, tasks: [...DOCUMENT.tasks, external] };
    const draft = { title: "Local edited", type: "feature" as const, expectedTask: DOCUMENT.tasks[0]! };
    await expect(store.update("task-1", draft)).resolves.toBe(false);
    await expect(store.update("task-1", draft)).resolves.toBe(true);
    expect(disk.tasks.find((task) => task.id === "external")).toEqual(external);
    expect(disk.tasks.find((task) => task.id === "task-1")?.title).toBe("Local edited");
  });

  it("keeps the loaded document on malformed polls, reports once and recovers on a valid read", async () => {
    const { store, reportError } = fixture();
    tauri.invoke.mockResolvedValueOnce(DOCUMENT);
    await store.load("/project");
    tauri.invoke.mockRejectedValue(new Error("Malformed external JSONC"));
    const stop = store.observe();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.document).toEqual(DOCUMENT);
    expect(store.loadFailed).toBe(true);
    expect(reportError).toHaveBeenCalledOnce();
    tauri.invoke.mockResolvedValue({ ...DOCUMENT, tasks: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.document.tasks).toEqual([]);
    expect(store.loadFailed).toBe(false);
    stop();
  });
});
