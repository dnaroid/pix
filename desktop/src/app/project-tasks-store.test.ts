import { beforeEach, describe, expect, it, vi } from "vitest";

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
