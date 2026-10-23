import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import WorkspaceSidebarTasksPanel from "./WorkspaceSidebarTasksPanel.svelte";
import { sortProjectTasksByPriority, type ProjectTask } from "../lib/project-tasks";
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
  it("keeps the header compact and duplicates the full title in the expanded body", () => {
    const title = "A long task title that must remain fully readable when details are expanded";
    for (const expanded of [true, false]) {
      const html = markup({ tasks: [{ ...task, title }], expandedTaskIds: new Set(expanded ? [task.id] : []) });
      const heading = html.match(/<h3[^>]*title="[^"]*"[^>]*>[\s\S]*?<\/h3>/)?.[0];
      expect(heading).toContain(title);
      expect(heading).toContain("truncate");
      if (expanded) {
        const bodyTitle = html.match(/<p[^>]*data-task-detail-title[^>]*>[\s\S]*?<\/p>/)?.[0];
        expect(bodyTitle).toContain(title);
        expect(bodyTitle).toContain("whitespace-pre-wrap break-words");
        expect(bodyTitle).not.toContain("truncate");
        expect(html.indexOf("data-task-detail-title")).toBeLessThan(html.indexOf("data-task-description"));
      } else expect(html).not.toContain("data-task-detail-title");
    }
  });

  it("restores expanded details on remount and refreshed task objects from owner state", () => {
    const view = createWorkspaceSidebarTasksViewController();
    view.selectWorkspace("/project");
    view.expandedTaskIds = new Set([task.id]);
    for (const description of ["Original details", "Refreshed details"]) {
      const html = markup({ tasks: [{ ...task, description }], expandedTaskIds: view.expandedTaskIds });
      expect(html).toContain(description);
      expect(html).toMatch(/data-task-details-toggle[^>]*aria-expanded="true"/);
      expect(html).not.toContain(`id="task-details-${task.id}" hidden`);
    }
    view.expandedTaskIds = new Set();
    const html = markup({ tasks: [{ ...task, description: "Hidden again" }], expandedTaskIds: view.expandedTaskIds });
    expect(html).not.toContain("Hidden again");
    expect(html).toMatch(/data-task-details-toggle[^>]*aria-expanded="false"/);
  });

  it("keeps filters outside the task list scroll area", () => {
    const html = markup();
    const filters = html.indexOf("data-task-filters");
    const scrollArea = html.indexOf("data-task-list-scroll");
    expect(filters).toBeGreaterThan(0);
    expect(scrollArea).toBeGreaterThan(filters);
    expect(html.slice(filters, scrollArea)).toContain("</div> <div");
    expect(html).toMatch(/class="[^"]*shrink-0[^"]*" data-task-filters/);
    expect(html).toMatch(/class="[^"]*min-h-0[^"]*overflow-y-auto[^"]*" data-task-list-scroll/);
    expect(html).toMatch(/id="workspace-tasks-panel" class="[^"]*overflow-hidden/);
  });

  it("adds a collapsed, keyboard-accessible chevron left of each title without opening the editor or dragging", () => {
    const html = markup({ tasks: [{ ...task, description: "Hidden details" }] });
    const toggle = html.match(/<button[^>]*data-task-details-toggle[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(toggle).toContain('aria-label="Toggle details for Existing task"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain(`aria-controls="task-details-${task.id}"`);
    expect(toggle).toContain("lucide-chevron-down");
    expect(toggle).toContain("-rotate-90");
    expect(html.indexOf("data-task-details-toggle")).toBeLessThan(html.indexOf('aria-label="Type: Feature"'));
    expect(html).toContain(`id="task-details-${task.id}" hidden`);
    expect(html).not.toContain("Hidden details");
    expect(panelSource).toContain('detailsExpanded ? "rotate-0" : "-rotate-90"');
    expect(panelSource).toContain("onclick={() => toggleTaskDetails(task.id)}");
    expect(panelSource).toContain('[data-task-details]');
    expect(panelSource).toContain("if (isInteractiveTarget(event.target)) return;");
  });

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
    expect(html.match(/aria-label="Toggle [^"]+ tasks"/g)).toHaveLength(5);
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

  it("groups each status by descending priority and sorts cards within each priority by type", () => {
    const tasks: ProjectTask[] = [
      { ...task, id: "feature-low", priority: "low" },
      { ...task, id: "idea-urgent", type: "idea", priority: "urgent" },
      { ...task, id: "improvement-high", type: "improvement", priority: "high" },
      { ...task, id: "feature-medium" },
      { ...task, id: "bug-low", type: "bug", priority: "low" },
      { ...task, id: "feature-high-first", priority: "high" },
      { ...task, id: "bug-urgent", type: "bug", priority: "urgent" },
      { ...task, id: "feature-urgent", priority: "urgent" },
      { ...task, id: "feature-high-second", priority: "high" },
      { ...task, id: "backlog-feature", status: "backlog" },
    ];
    const original = tasks.map((task) => ({ ...task }));
    const html = markup({ tasks });
    expect([...html.matchAll(/data-task-id="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "bug-urgent", "feature-urgent", "idea-urgent", "feature-high-first", "feature-high-second",
      "improvement-high", "feature-medium", "bug-low", "feature-low", "backlog-feature",
    ]);
    expect([...html.matchAll(/data-task-priority-group="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["urgent", "high", "medium", "low", "medium"]);
    expect(html).not.toContain("data-task-priority-heading");
    expect(html).not.toContain("data-task-type-heading");
    expect(html).not.toContain("data-task-type-group");
    for (const label of ["Urgent", "High", "Medium", "Low"])
      expect(html).toContain(`aria-label="${label} tasks"`);
    expect(tasks).toEqual(original);
  });

  it("omits empty priority groups after filtering and in collapsed statuses", () => {
    const tasks: ProjectTask[] = [
      { ...task, id: "low-feature", priority: "low" },
      { ...task, id: "high-bug", type: "bug", priority: "high" },
      { ...task, id: "done-bug", type: "bug", status: "done", priority: "high" },
    ];
    const html = markup({ tasks, typeFilter: "bug", priorityFilter: "high" });
    expect([...html.matchAll(/data-task-priority-group="([^"]+)"/g)].map((match) => match[1])).toEqual(["high"]);
    expect([...html.matchAll(/data-task-id="([^"]+)"/g)].map((match) => match[1])).toEqual(["high-bug"]);
    expect(html).toContain('title="2 total tasks">2</span>');
    expect(markup({ tasks: [] })).not.toContain("data-task-priority-group");
  });

  it("retains drag targets inside a priority group", () => {
    const html = markup({
      tasks: [{ ...task, id: "first", priority: "high" }, { ...task, id: "second", priority: "high" }],
      draggedTaskId: "second", draggedTaskHeight: 36,
      taskDropTarget: { status: "todo", targetTaskId: "first", position: "before" },
    });
    expect(html.indexOf('data-task-priority-group="high"')).toBeLessThan(html.indexOf("data-task-drop-placeholder"));
    expect(html.indexOf("data-task-drop-placeholder")).toBeLessThan(html.indexOf('data-task-id="first"'));
    expect(html.indexOf('data-task-id="first"')).toBeLessThan(html.indexOf('data-task-id="second"'));
    expect(html).toContain("min-height: 36px");
  });

  it("keeps saved ordering among equal priorities without mutating task rows", () => {
    const tasks: ProjectTask[] = [
      { ...task, id: "low", priority: "low" },
      { ...task, id: "high-2", priority: "high" },
      { ...task, id: "medium" },
      { ...task, id: "high-1", priority: "high" },
      { ...task, id: "urgent", priority: "urgent" },
    ];
    const original = [...tasks];
    const sorted = sortProjectTasksByPriority(tasks);
    expect(sorted.map((task) => task.id)).toEqual(["urgent", "high-2", "high-1", "medium", "low"]);
    expect(tasks).toEqual(original);
    expect(sorted[0]).toBe(tasks[4]);
    expect(sortProjectTasksByPriority([])).toEqual([]);
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

  it("suggests marking a task done only when its linked plan checklist is complete", () => {
    const plan = ".pi/plans/ship.md";
    const linked = { ...task, links: [plan] };
    const complete = markup({ tasks: [linked], planProgress: { [plan]: { completed: 3, total: 3 } }, isStatusCollapsed: () => false });
    expect(complete).toContain("data-task-mark-done");
    expect(complete).toContain('aria-label="Mark Existing task done"');
    for (const [tasks, progress] of [
      [[linked], { [plan]: { completed: 2, total: 3 } }],
      [[linked], { [plan]: { completed: 0, total: 0 } }],
      [[linked], { [plan]: null }],
      [[{ ...linked, status: "done" as const }], { [plan]: { completed: 3, total: 3 } }],
      [[task], { [plan]: { completed: 3, total: 3 } }],
    ] as const) {
      expect(markup({ tasks: [...tasks], planProgress: progress, isStatusCollapsed: () => false })).not.toContain("data-task-mark-done");
    }
    expect(markup({ tasks: [linked], busy: true, planProgress: { [plan]: { completed: 3, total: 3 } }, isStatusCollapsed: () => false }))
      .toMatch(/data-task-mark-done[^>]*disabled/);
  });
});
