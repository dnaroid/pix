import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebarTaskDragController } from "./workspace-sidebar-task-drag-controller.svelte";
import { TASK_STATUSES } from "../lib/project-tasks";

afterEach(() => vi.unstubAllGlobals());

function fixture(status: string, cardIds: string[] = []) {
  const style = { userSelect: "text", cursor: "default" };
  const cards = cardIds.map((id, index) => ({
    dataset: { taskId: id },
    getBoundingClientRect: () => ({ top: 30 + index * 50, height: 40 }),
  }));
  const group = {
    dataset: { taskStatusGroup: status },
    getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, bottom: 200 }),
    querySelectorAll: () => cards,
  };
  vi.stubGlobal("document", {
    documentElement: { style }, elementFromPoint: () => null,
    querySelectorAll: () => [group],
  });
  const onReorder = vi.fn();
  const controller = createWorkspaceSidebarTaskDragController({ busy: () => false, closeStatusMenu: vi.fn(), onReorder });
  const handle = {
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 50 }) }),
    setPointerCapture: vi.fn(),
  };
  const event = (y: number) => ({ pointerId: 1, button: 0, clientX: 10, clientY: y,
    currentTarget: handle, preventDefault: vi.fn() }) as unknown as PointerEvent;
  controller.start(event(10), "source");
  return { controller, event, onReorder, style };
}

describe("task drag status groups", () => {
  it.each(TASK_STATUSES)("can drop into an empty %s group, including collapsed Done headers", (status) => {
    const { controller, event, onReorder, style } = fixture(status);
    controller.move(event(25));
    expect(controller.dropTarget).toEqual({ status, targetTaskId: null, position: "after" });
    controller.finish(event(25));
    expect(onReorder).toHaveBeenCalledWith("source", status, null, "after");
    expect(controller.consumeClick()).toBe(true);
    expect(controller.consumeClick()).toBe(false);
    expect(style).toEqual({ userSelect: "text", cursor: "default" });
  });

  it("keeps a tap or sub-threshold motion as a click without capturing the pointer or reordering", () => {
    const { controller, event, onReorder, style } = fixture("todo", ["source", "next"]);
    expect(controller.taskId).toBeNull();
    controller.move(event(14));
    expect(controller.taskId).toBeNull();
    expect(controller.dropTarget).toBeNull();
    controller.finish(event(14));
    expect(controller.consumeClick()).toBe(false);
    expect(onReorder).not.toHaveBeenCalled();
    expect(style).toEqual({ userSelect: "text", cursor: "default" });
  });

  it("retains before/after reordering and restores shared styles on teardown", () => {
    const { controller, event, style } = fixture("todo", ["source", "first", "last"]);
    controller.move(event(65));
    expect(controller.dropTarget).toEqual({ status: "todo", targetTaskId: "first", position: "before" });
    controller.move(event(180));
    expect(controller.dropTarget).toEqual({ status: "todo", targetTaskId: "last", position: "after" });
    expect(style.cursor).toBe("grabbing");
    controller.dispose();
    expect(controller.taskId).toBeNull();
    expect(style).toEqual({ userSelect: "text", cursor: "default" });
  });

  it("does not accept unknown groups or commit a cancelled drag", () => {
    const { controller, event, onReorder, style } = fixture("feature");
    controller.move(event(10));
    expect(controller.dropTarget).toBeNull();
    controller.cancel(event(10));
    controller.finish(event(10));
    expect(onReorder).not.toHaveBeenCalled();
    expect(style).toEqual({ userSelect: "text", cursor: "default" });
  });

  it("cancels a valid target without reordering and ignores unrelated pointer events", () => {
    const { controller, event, onReorder, style } = fixture("done");
    controller.move(event(25));
    controller.finish({ ...event(10), pointerId: 2 });
    expect(controller.taskId).toBe("source");
    controller.cancel(event(10));
    expect(onReorder).not.toHaveBeenCalled();
    expect(controller.dropTarget).toBeNull();
    expect(style).toEqual({ userSelect: "text", cursor: "default" });
  });
});
