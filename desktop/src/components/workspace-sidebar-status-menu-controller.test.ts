import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { createWorkspaceSidebarStatusMenuController } from "./workspace-sidebar-status-menu-controller.svelte";
import { TASK_PRIORITIES, TASK_STATUSES, type ProjectTask } from "../lib/project-tasks";

// Deterministic DOM doubles; WebView interaction is a separate QA gate.
class ElementDouble {
  isConnected = true;
  disabled = false;
  focus = vi.fn();
  closest = () => this;
  contains = (target: unknown) => target === this;
}
const task: ProjectTask = {
  id: "task", title: "Task", type: "feature", status: "todo", priority: "high",
  createdAt: "2026-09-13T12:00:00.000Z", updatedAt: "2026-09-13T12:00:00.000Z",
};
function fixture() {
  vi.stubGlobal("Element", ElementDouble);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const trigger = new ElementDouble();
  let buttons = Array.from({ length: TASK_STATUSES.length + TASK_PRIORITIES.length + 1 }, () => new ElementDouble());
  const menu = { querySelectorAll: () => buttons, contains: (target: unknown) => buttons.includes(target as ElementDouble) };
  const querySelector = vi.fn();
  vi.stubGlobal("document", { querySelector });
  const onStatusChange = vi.fn(), onPriorityChange = vi.fn(), onDeleteRequest = vi.fn();
  const controller = createWorkspaceSidebarStatusMenuController({
    menu: () => menu as unknown as HTMLDivElement, onStatusChange, onPriorityChange, onDeleteRequest,
  });
  const event = { currentTarget: trigger } as unknown as MouseEvent;
  const key = (value: string, target = buttons[0]) => controller.handleKeydown({
    key: value, target, preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent);
  return { controller, trigger, event, key, onStatusChange, onPriorityChange, onDeleteRequest, querySelector,
    get buttons() { return buttons; }, priorityOnly() { buttons = buttons.slice(0, 4); } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("unified task-card menu", () => {
  it("focuses current status from ellipsis and current priority from a badge", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task);
    await tick();
    expect(f.buttons[1]!.focus).toHaveBeenCalled();
    f.priorityOnly();
    f.controller.toggle(f.event, task, "priority");
    await tick();
    expect(f.controller.section).toBe("priority");
    expect(f.buttons[2]!.focus).toHaveBeenCalled();
    f.controller.toggle(f.event, task, "priority");
    expect(f.controller.taskId).toBeNull();
  });

  it.each(["all", "priority"] as const)("changes priority including medium through the %s menu and restores focus", async (section) => {
    const f = fixture();
    if (section === "priority") f.priorityOnly();
    f.controller.toggle(f.event, task, section);
    f.controller.setPriority(task.id, "medium");
    await tick();
    expect(f.onPriorityChange).toHaveBeenCalledWith(task.id, "medium");
    expect(f.controller.taskId).toBeNull();
    expect(f.trigger.focus).toHaveBeenCalled();
  });

  it("restores focus to ellipsis if changing to medium removes the priority badge", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task, "priority");
    f.trigger.isConnected = false;
    const revived = new ElementDouble();
    f.querySelector.mockReturnValue(revived);
    f.controller.setPriority(task.id, "medium");
    await tick();
    expect(revived.focus).toHaveBeenCalled();
  });

  it("navigates across status, priority and delete with arrows Home End and typeahead", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.controller.toggle(f.event, task);
    await tick();
    f.key("End");
    expect(f.buttons.at(-1)!.focus).toHaveBeenCalled();
    f.key("Home", f.buttons.at(-1));
    expect(f.buttons[0]!.focus).toHaveBeenCalled();
    f.key("ArrowDown", f.buttons[3]);
    expect(f.buttons[4]!.focus).toHaveBeenCalled();
    f.key("u");
    expect(f.buttons[TASK_STATUSES.length + TASK_PRIORITIES.indexOf("urgent")]!.focus).toHaveBeenCalled();
    f.key("f");
    expect(f.buttons[TASK_STATUSES.indexOf("failed")]!.focus).toHaveBeenCalled();
    f.key("d");
    expect(f.buttons[3]!.focus).toHaveBeenCalled();
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("focuses the group toggle if a priority filter removes the changed card", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task, "priority");
    f.trigger.isConnected = false;
    const groupToggle = new ElementDouble();
    f.querySelector.mockImplementation((selector: string) => selector.includes("data-task-status-group") ? groupToggle : null);
    f.controller.setPriority(task.id, "medium");
    await tick();
    expect(f.querySelector).toHaveBeenCalledWith('[data-task-status-group="todo"] [aria-controls="workspace-tasks-todo-list"]');
    expect(groupToggle.focus).toHaveBeenCalled();
  });

  it("routes delete through the parent confirmation callback after dismissing", () => {
    const f = fixture();
    f.controller.toggle(f.event, task);
    f.controller.requestDelete(task.id);
    expect(f.controller.taskId).toBeNull();
    expect(f.onDeleteRequest).toHaveBeenCalledWith(task.id);
  });

  it("skips a disabled focus target left over from a pending save and falls back to the next candidate", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task, "priority");
    f.trigger.disabled = true;
    const revived = new ElementDouble();
    revived.disabled = true;
    const groupToggle = new ElementDouble();
    f.querySelector.mockImplementation((selector: string) => selector.includes("data-task-status-group") ? groupToggle : revived);
    f.controller.setPriority(task.id, "medium");
    await tick();
    expect(f.trigger.focus).not.toHaveBeenCalled();
    expect(revived.focus).not.toHaveBeenCalled();
    expect(groupToggle.focus).toHaveBeenCalled();
  });

  it("escapes task ids containing quotes so focus restoration cannot throw", async () => {
    const f = fixture();
    const quotedTask: ProjectTask = { ...task, id: 'task"with"quotes' };
    const quotedEvent = { currentTarget: f.trigger } as unknown as MouseEvent;
    f.controller.toggle(quotedEvent, quotedTask, "priority");
    f.trigger.isConnected = false;
    const revived = new ElementDouble();
    f.querySelector.mockReturnValue(revived);
    expect(() => f.controller.setPriority(quotedTask.id, "medium")).not.toThrow();
    await tick();
    expect(f.querySelector).toHaveBeenCalledWith(expect.stringContaining('task\\"with\\"quotes'));
    expect(revived.focus).toHaveBeenCalled();
  });

  it.each(["in-progress", "todo", "backlog", "done", "failed"] as const)("restores focus to a collapsed %s group's toggle after a status move", async (status) => {
    const f = fixture();
    f.controller.toggle(f.event, task);
    f.trigger.isConnected = false;
    const toggle = new ElementDouble();
    f.querySelector.mockImplementation((selector: string) => selector.includes("data-task-status-group") ? toggle : null);
    f.controller.setStatus(task.id, status);
    await tick();
    expect(f.onStatusChange).toHaveBeenCalledWith(task.id, status);
    expect(f.querySelector).toHaveBeenCalledWith(`[data-task-status-group="${status}"] [aria-controls="workspace-tasks-${status}-list"]`);
    expect(toggle.focus).toHaveBeenCalled();
  });

  it("dismisses on Escape with focus restoration, Tab, and outside pointers only", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task);
    f.controller.closeOutside({ target: f.buttons[0] } as unknown as PointerEvent);
    expect(f.controller.taskId).toBe(task.id);
    f.key("Escape");
    await tick();
    expect(f.trigger.focus).toHaveBeenCalled();
    f.controller.toggle(f.event, task);
    f.key("Tab");
    expect(f.controller.taskId).toBeNull();
    f.controller.toggle(f.event, task);
    f.controller.closeOutside({ target: new ElementDouble() } as unknown as PointerEvent);
    expect(f.controller.taskId).toBeNull();
  });

  it("does not focus stale popup items after closing or disposing before tick", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task);
    f.controller.close();
    await tick();
    expect(f.buttons.every((button) => button.focus.mock.calls.length === 0)).toBe(true);
    f.controller.toggle(f.event, task);
    f.controller.dispose();
    await tick();
    expect(f.buttons.every((button) => button.focus.mock.calls.length === 0)).toBe(true);
  });

  it("invalidates pending focus restoration when another card opens", async () => {
    const f = fixture();
    f.controller.toggle(f.event, task, "priority");
    f.controller.setPriority(task.id, "medium");
    f.controller.toggle(f.event, { ...task, id: "next-task", status: "done" });
    await tick();
    expect(f.trigger.focus).not.toHaveBeenCalled();
    expect(f.buttons[3]!.focus).toHaveBeenCalledTimes(1);
    expect(f.buttons[2]!.focus).not.toHaveBeenCalled();
  });
});
