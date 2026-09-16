import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import type { ProjectFilePreview } from "../lib/project-files";
import { PROJECT_TODO_PATH } from "../lib/project-documents";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

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

describe("project Markdown writes", () => {
  beforeEach(() => { tauri.invoke.mockReset(); });

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
});
