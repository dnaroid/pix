import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebarTasksViewController } from "./workspace-sidebar-tasks-view-controller.svelte";
import { projectTasksCollapsedStatusesKey } from "../lib/project-tasks-view-storage";
import { TASK_STATUSES } from "../lib/project-tasks";

afterEach(() => vi.unstubAllGlobals());

describe("workspace task presentation persistence", () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }

  it.each(TASK_STATUSES)("persists independent %s collapse on reopening and isolates workspaces", (status) => {
    const persisted = storage();
    const view = createWorkspaceSidebarTasksViewController(persisted);
    view.selectWorkspace("/alpha");
    for (const value of TASK_STATUSES) expect(view.isStatusCollapsed(value)).toBe(value === "done");
    view.toggleStatusCollapsed(status);
    expect(JSON.parse(persisted.getItem(projectTasksCollapsedStatusesKey("/alpha"))!)[status]).toBe(status !== "done");
    for (const value of TASK_STATUSES.filter((value) => value !== status)) expect(view.isStatusCollapsed(value)).toBe(value === "done");
    view.selectWorkspace("/beta");
    expect(view.isStatusCollapsed(status)).toBe(status === "done");
    view.selectWorkspace("/alpha");
    expect(view.isStatusCollapsed(status)).toBe(status !== "done");

    const reopened = createWorkspaceSidebarTasksViewController(persisted);
    reopened.selectWorkspace("/alpha");
    expect(reopened.isStatusCollapsed(status)).toBe(status !== "done");
    reopened.toggleStatusCollapsed(status);
    const restarted = createWorkspaceSidebarTasksViewController(persisted);
    restarted.selectWorkspace("/alpha");
    expect(restarted.isStatusCollapsed(status)).toBe(status === "done");
    expect(persisted.getItem(projectTasksCollapsedStatusesKey("/beta"))).toBeNull();
  });

  it("keeps window-local filters across panel workspace selections without persisting them", () => {
    const persisted = storage();
    const view = createWorkspaceSidebarTasksViewController(persisted);
    view.selectWorkspace("/alpha");
    view.typeFilter = "idea";
    view.priorityFilter = "urgent";
    view.selectWorkspace("/alpha");
    expect(view.typeFilter).toBe("idea");
    expect(view.priorityFilter).toBe("urgent");
    const reopened = createWorkspaceSidebarTasksViewController(persisted);
    expect(reopened.typeFilter).toBe("all");
    expect(reopened.priorityFilter).toBe("all");
  });

  it("stays usable with unavailable, throwing, or corrupt storage", () => {
    for (const persisted of [undefined, { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } }, { getItem: () => "invalid", setItem: () => {} }]) {
      vi.stubGlobal("localStorage", undefined);
      const view = createWorkspaceSidebarTasksViewController(persisted);
      view.selectWorkspace("/alpha");
      expect(view.isStatusCollapsed("done")).toBe(true);
      expect(() => { view.toggleStatusCollapsed("done"); }).not.toThrow();
      expect(view.isStatusCollapsed("done")).toBe(false);
    }
  });

  it("validates each stored status and ignores obsolete or malformed preferences", () => {
    const persisted = storage();
    persisted.setItem("pix.desktop.tasks.doneCollapsed:/alpha", "false");
    const view = createWorkspaceSidebarTasksViewController(persisted);
    view.selectWorkspace("/alpha");
    expect(view.isStatusCollapsed("done")).toBe(true);
    persisted.setItem(projectTasksCollapsedStatusesKey("/beta"), JSON.stringify({ todo: true, backlog: "true", done: false, extra: true }));
    view.selectWorkspace("/beta");
    expect(view.isStatusCollapsed("todo")).toBe(true);
    expect(view.isStatusCollapsed("backlog")).toBe(false);
    expect(view.isStatusCollapsed("done")).toBe(false);
    expect(view.isStatusCollapsed("failed")).toBe(false);
    for (const raw of ["null", "[]", "false", "invalid"]) {
      persisted.setItem(projectTasksCollapsedStatusesKey(raw), raw);
      view.selectWorkspace(raw);
      for (const status of TASK_STATUSES) expect(view.isStatusCollapsed(status)).toBe(status === "done");
    }
  });

  it("expands a revealed task's group and preserves other collapse preferences", () => {
    const persisted = storage();
    const view = createWorkspaceSidebarTasksViewController(persisted);
    view.selectWorkspace("/alpha");
    view.toggleStatusCollapsed("todo");
    view.expandStatus("todo");
    expect(view.isStatusCollapsed("todo")).toBe(false);
    expect(view.isStatusCollapsed("done")).toBe(true);
    view.expandStatus("done");
    const reopened = createWorkspaceSidebarTasksViewController(persisted);
    reopened.selectWorkspace("/alpha");
    expect(reopened.isStatusCollapsed("done")).toBe(false);
    view.selectWorkspace("");
    view.toggleStatusCollapsed("todo");
    expect(persisted.getItem(projectTasksCollapsedStatusesKey(""))).toBeNull();
  });
});
