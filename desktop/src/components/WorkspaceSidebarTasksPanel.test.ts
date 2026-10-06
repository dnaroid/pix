import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import WorkspaceSidebarTasksPanel from "./WorkspaceSidebarTasksPanel.svelte";
import type { ProjectTask } from "../lib/project-tasks";

const task: ProjectTask = {
  id: "existing-task",
  title: "Existing task",
  type: "feature",
  status: "todo",
  priority: "medium",
  createdAt: "2026-09-13T12:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};
const noop = () => {};

function markup(overrides: Partial<ComponentProps<typeof WorkspaceSidebarTasksPanel>> = {}): string {
  return render(WorkspaceSidebarTasksPanel, { props: {
    workspace: "/project", tasks: [task], loading: false, storageError: false,
    busy: false, activeTaskId: null, sessionReady: true, draggedTaskId: null,
    taskDropTarget: null, draggedTaskHeight: 0, revealedTaskId: null,
    statusMenuTaskId: null, statusMenu: null,
    onPanelPointerDown: noop, onReload: noop, onTaskDragStart: noop,
    onTaskDragMove: noop, onTaskDragFinish: noop, onTaskDragCancel: noop,
    onToggleStatusMenu: noop, onStatusMenuKeydown: noop, onSetTaskStatus: noop,
    onRun: noop, onOpenSession: noop, onCreate: noop, onEdit: noop, onDeleteRequest: noop,
    ...overrides,
  } }).body;
}

describe("task group creation and stable refresh presentation", () => {
  it.each([{ tasks: [task] }, { tasks: [] }])("shows an accessible add button beside every group count: %j", ({ tasks }) => {
    const html = markup({ tasks });
    for (const label of ["Bug", "Feature", "Improve"]) {
      expect(html).toContain(`aria-label="${label} tasks"`);
      expect(html).toContain(`aria-label="Add ${label} task"`);
      expect(html).toMatch(new RegExp(`${label}</span>.*?<span[^>]*>\\d+</span>.*?<button[^>]*aria-label="Add ${label} task"`, "s"));
    }
    expect((html.match(/title="Add /g) ?? []).length).toBe(3);
  });

  it("keeps list and control styles unchanged while locking conflicting actions", () => {
    const idle = markup();
    const locked = markup({ busy: true });
    const classes = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);
    expect(classes(locked)).toEqual(classes(idle));
    expect(locked).not.toContain("disabled:opacity");
    expect(locked).not.toContain("Loading tasks");
    expect(locked).toContain('data-task-id="existing-task"');
    expect((locked.match(/ disabled(?:[=\s>])/g) ?? []).length).toBe(8);
    expect(idle).not.toMatch(/ disabled(?:[=\s>])/);
  });

  it("still dims the session action when no session is ready", () => {
    const html = markup({ sessionReady: false });
    expect(html).toMatch(/<button[^>]*class="[^"]*opacity-35[^>]*aria-label="Run Existing task"[^>]* disabled/);
    expect((html.match(/ disabled(?:[=\s>])/g) ?? []).length).toBe(1);
  });

  it("does not expose group creation before initial load, without a project, or on storage error", () => {
    for (const overrides of [{ loading: true }, { workspace: "" }, { storageError: true }]) {
      expect(markup(overrides)).not.toContain('title="Add ');
    }
    expect(markup({ loading: true })).toContain("Loading tasks");
    expect(markup({ storageError: true })).toContain("Task file needs attention");
  });
});
