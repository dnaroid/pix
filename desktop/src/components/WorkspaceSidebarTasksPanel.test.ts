import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import WorkspaceSidebarTasksPanel from "./WorkspaceSidebarTasksPanel.svelte";
import type { ProjectTask } from "../lib/project-tasks";
import panelSource from "./WorkspaceSidebarTasksPanel.svelte?raw";
import { createWorkspaceSidebarTasksViewController } from "./workspace-sidebar-tasks-view-controller.svelte";

const task: ProjectTask = {
  id: "existing-task", title: "Existing task", type: "feature",
  status: "todo", priority: "medium",
  createdAt: "2026-09-13T12:00:00.000Z", updatedAt: "2026-09-13T12:00:00.000Z",
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

describe("interactive project Tasks panel", () => {
  it("opens the editor by clicking the card while preserving status, priority, delete and drag", () => {
    const html = markup({
      tasks: [{ ...task, priority: "urgent" }],
      statusMenuTaskId: task.id,
      isStatusCollapsed: () => false,
    });
    for (const control of ["Add Todo task", "Open task editor",
      "Change status for Existing task", "Delete Existing task",
      'aria-haspopup="menu"', 'role="menuitemradio"',
      "Drag to reorder or change status", "Priority: Urgent"]) expect(html).toContain(control);
    expect(panelSource).toContain("onTaskDragStart(event");
    expect(panelSource).toContain("onCardDragClickConsumed()");
    expect(html).not.toContain('aria-label="Edit Existing task"');
    expect(panelSource).toContain('onclick={() => onCreate(');
    expect(html).toContain('data-task-title-row');
    const drop = markup({ draggedTaskId: task.id,
      taskDropTarget: { status: "backlog", targetTaskId: null, position: "after" } });
    expect(drop).toContain("data-task-drop-placeholder");
  });

  it("keeps all five status groups, counts and visible rotating disclosure chevrons", () => {
    const html = markup();
    expect([...html.matchAll(/data-task-status-group="([^"]+)"/g)].map(match => match[1]))
      .toEqual(["in-progress", "todo", "backlog", "done", "failed"]);
    expect(html.match(/aria-label="Toggle /g)).toHaveLength(5);
    expect(html).toContain('title="1 total tasks">1</span>');
    expect(html).not.toContain(">Empty<");
    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain("-rotate-90");
    expect(html).toContain("rotate-0");
  });

  it("offers priority-only menu on the badge and status/priority menu on the row", () => {
    const priority = markup({
      tasks: [{ ...task, priority: "high" }], statusMenuTaskId: task.id,
      statusMenuSection: "priority",
    });
    expect(priority).toContain('aria-label="Priority for Existing task"');
    expect(priority.match(/role="menuitemradio"/g)).toHaveLength(4);
    expect(priority).not.toContain('role="group" aria-label="Status"');
    const all = markup({ statusMenuTaskId: task.id });
    expect(all).toContain('role="group" aria-label="Status"');
    expect(all).toContain('aria-label="Delete Existing task"');
  });

  it.each([
    ["In progress", "text-tool-warning"], ["Todo", "text-tool-info"],
    ["Backlog", "text-tool-neutral"], ["Done", "text-tool-success"],
    ["Failed", "text-tool-error"],
  ])("preserves the semantic tone and disclosure of %s", (label, tone) => {
    for (const collapsed of [true, false]) {
      const html = markup({ isStatusCollapsed: () => collapsed });
      const button = html.match(new RegExp(`<button[^>]*aria-label="Toggle ${label} tasks"[^>]*>.*?</button>`, "s"))?.[0];
      expect(button).toContain(`<span class="${tone} opacity-80">${label}</span>`);
      expect(button).toContain(collapsed ? "-rotate-90" : "rotate-0");
    }
  });

  it("retains combined type and priority filters without editing the database", () => {
    const tasks: ProjectTask[] = [
      task, { ...task, id: "urgent", type: "idea", priority: "urgent", status: "backlog" },
      { ...task, id: "done", type: "bug", status: "done" },
    ];
    const html = markup({ tasks, typeFilter: "idea", priorityFilter: "urgent", isStatusCollapsed: () => false });
    expect(html).toContain('data-task-id="urgent"');
    expect(html).not.toContain('data-task-id="existing-task"');
    expect(html).not.toContain('data-task-id="done"');
    expect(html).toContain('aria-label="Filter tasks by type"');
    expect(html).toContain('aria-label="Filter tasks by priority"');
    expect(html).toContain('title="1 total tasks">1</span>');
    expect(html).not.toContain("tasks ·");
  });

  it("keeps run/open controls but disables them when session runtime is unavailable", () => {
    expect(markup()).toContain('aria-label="Run Existing task"');
    const unavailable = markup({ sessionReady: false });
    expect(unavailable).toMatch(/<button[^>]*opacity-35[^>]*aria-label="Run Existing task"[^>]* disabled/);
    const linked = markup({ tasks: [{ ...task, sessionId: "session-1", links: ["docs/idea.md", "<unsafe>"] }] });
    expect(linked).toContain('aria-label="Open session for Existing task"');
    expect(linked).toContain('aria-label="2 links"');
    expect(linked).not.toContain("<unsafe>");
  });

  it("shows compact linked-file, attachment, subtask, epic and model indicators", () => {
    const parent = { ...task, id: "parent", title: "Epic objective", epic: true };
    const child = { ...task, id: "child", title: "Subtask", parentId: "parent", modelRef: "provider/model", links: ["docs/spec.md"] };
    const sibling = { ...task, id: "sibling", title: "Sibling", parentId: "parent" };
    const html = markup({ tasks: [parent, child, sibling], attachmentCounts: { child: 2 }, isStatusCollapsed: () => false });
    expect(html).toContain('data-task-epic');
    expect(html).toContain('aria-label="Epic with 2 subtasks"');
    expect(html).toContain('data-task-subtask');
    expect(html).toContain('aria-label="Subtask of Epic objective"');
    expect(html).toContain('aria-label="2 attachments"');
    expect(html).toContain('aria-label="1 links"');
    expect(html).toContain('aria-label="Assigned model: provider/model"');
    expect(html).not.toContain('aria-label="Edit Subtask"');
  });

  it("shows loading, unavailable database and missing-project states safely", () => {
    expect(markup({ loading: true })).toContain("Loading tasks");
    expect(markup({ storageError: true })).toContain("Task database needs attention");
    expect(markup({ storageError: true })).toContain(".pi/tasks.sqlite");
    expect(markup({ workspace: "" })).toContain("Choose a project");
    for (const overrides of [{ loading: true }, { storageError: true }, { workspace: "" }])
      expect(markup(overrides)).not.toContain("/task delete");
  });

  it("preserves workspace-specific collapsed status preferences independently of SQLite", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); } };
    const view = createWorkspaceSidebarTasksViewController(storage);
    view.selectWorkspace("/project");
    const done = [{ ...task, status: "done" as const }];
    expect(markup({ tasks: done, isStatusCollapsed: view.isStatusCollapsed })).not.toContain("data-task-id");
    view.toggleStatusCollapsed("done");
    const reopened = createWorkspaceSidebarTasksViewController(storage);
    reopened.selectWorkspace("/project");
    expect(markup({ tasks: done, isStatusCollapsed: reopened.isStatusCollapsed })).toContain('data-task-id="existing-task"');
    reopened.selectWorkspace("/other");
    expect(markup({ tasks: done, isStatusCollapsed: reopened.isStatusCollapsed })).not.toContain("data-task-id");
  });

  it.each([
    ["bug", "text-tool-error/75", "lucide-bug"],
    ["feature", "text-tool-success/75", "lucide-sparkles"],
    ["improvement", "text-tool-info/75", "lucide-wrench"],
    ["idea", "text-tool-warning/75", "lucide-lightbulb"],
  ] as const)("keeps distinct task type icon/tone for %s", (type, tone, icon) => {
    const html = markup({ tasks: [{ ...task, type }] });
    expect(html).toContain(tone);
    expect(html).toContain(icon);
  });
});
