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
