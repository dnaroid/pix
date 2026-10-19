import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkbenchTabMove, workbenchTabMove, workbenchTabMoveCommand, type WorkbenchTabMoveState } from "./workbench-tab-move";
import type { WorkbenchTabId } from "./workbench-tabs";

function fixture() {
  const host = new EventTarget();
  let ids: WorkbenchTabId[] = ["session:a", "preview", "session:b"];
  let state: WorkbenchTabMoveState | null = null;
  const buttons = ids.map((id, index) => ({
    dataset: { workbenchTabId: id },
    getBoundingClientRect: () => ({ left: index * 100, width: 100 }),
    scrollIntoView: vi.fn(),
  }));
  const node = {
    ownerDocument: { defaultView: host }, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 36 }),
    querySelectorAll: () => buttons,
    querySelector: () => buttons[0],
  } as unknown as HTMLElement;
  const commit = vi.fn();
  const focus = vi.fn();
  const controller = createWorkbenchTabMove({
    tablist: () => node, ids: () => ids, changed: (value) => { state = value; }, commit, focus,
  });
  function dispatch(type: string, props: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: 10, clientY: 18, button: 0, ...props });
    host.dispatchEvent(event);
    return event;
  }
  return { host, node, controller, commit, focus, dispatch, get state() { return state; }, setIds: (value: WorkbenchTabId[]) => { ids = value; } };
}

describe("menu-initiated workbench tab movement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves ordinary pointers untouched, intercepts only move-mode tab pointers, and consumes the placement click", () => {
    const f = fixture();
    expect(f.dispatch("pointerdown").defaultPrevented).toBe(false);
    f.controller.start("session:a");
    const titlebarPointerDown = vi.fn();
    f.host.addEventListener("pointerdown", titlebarPointerDown);
    expect(f.dispatch("pointerdown", { clientX: 280 }).defaultPrevented).toBe(true);
    expect(titlebarPointerDown).not.toHaveBeenCalled();
    expect(f.state).toEqual({ id: "session:a", beforeId: null });
    expect(f.dispatch("click", { clientX: 280 }).defaultPrevented).toBe(true);
    expect(f.commit).toHaveBeenCalledExactlyOnceWith("session:a", null);
    expect(f.state).toBeNull();
    expect(f.dispatch("pointerdown").defaultPrevented).toBe(false);
    expect(titlebarPointerDown).toHaveBeenCalledOnce();
    f.controller.destroy();
  });

  it("previews positions by pointer, scrolls at edges and cancels without swallowing an outside/window drag", () => {
    const f = fixture();
    f.controller.start("session:b");
    f.dispatch("pointermove", { clientX: 1 });
    expect(f.state?.beforeId).toBe("session:a");
    expect(f.node.scrollLeft).toBe(-24);
    expect(f.dispatch("pointerdown", { clientY: 50 }).defaultPrevented).toBe(false);
    expect(f.state).toBeNull();
    expect(f.commit).not.toHaveBeenCalled();
    f.controller.destroy();
  });

  it("supports keyboard placement without activating or closing tabs", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const f = fixture();
    f.controller.start("preview");
    expect(f.dispatch("keydown", { key: "ArrowLeft" }).defaultPrevented).toBe(true);
    expect(f.state?.beforeId).toBe("session:a");
    f.dispatch("keydown", { key: "End" });
    expect(f.state?.beforeId).toBeNull();
    f.dispatch("keydown", { key: "Home" });
    expect(f.state?.beforeId).toBe("session:a");
    f.dispatch("keydown", { key: "ArrowRight" });
    expect(f.state?.beforeId).toBe("session:b");
    f.dispatch("keydown", { key: "Enter" });
    expect(f.commit).toHaveBeenCalledExactlyOnceWith("preview", "session:b");
    expect(f.focus).toHaveBeenLastCalledWith("preview");
    f.controller.destroy();
  });

  it("cleans up on Escape, Tab, pointer cancellation, blur, a new context menu, replacement and teardown", () => {
    for (const [type, props] of [["keydown", { key: "Escape" }], ["keydown", { key: "Tab" }],
      ["pointercancel", {}], ["blur", {}], ["contextmenu", {}]] as const) {
      const f = fixture();
      f.controller.start("preview");
      const event = f.dispatch(type, props);
      if ("key" in props && props.key === "Tab") expect(event.defaultPrevented).toBe(false);
      expect(f.state).toBeNull();
      expect(f.dispatch("click").defaultPrevented).toBe(false);
      expect(f.commit).not.toHaveBeenCalled();
      f.controller.destroy();
    }
    const f = fixture();
    f.controller.start("preview");
    f.controller.start("session:a");
    f.controller.destroy();
    expect(f.dispatch("pointerdown").defaultPrevented).toBe(false);
    expect(f.dispatch("click").defaultPrevented).toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
    f.setIds(["session:a"]);
    f.controller.start("session:a");
    expect(f.state).toBeNull();
  });

  it("rejects callbacks after registration changes or a tab is unmounted", () => {
    const node = {} as HTMLElement;
    const start = vi.fn();
    const action = workbenchTabMove(node, start);
    const stale = workbenchTabMoveCommand(node)!;
    stale();
    expect(start).toHaveBeenCalledOnce();
    action.update(undefined);
    expect(workbenchTabMoveCommand(node)).toBeUndefined();
    stale();
    action.update(vi.fn());
    stale();
    action.destroy();
    expect(workbenchTabMoveCommand(node)).toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
  });

  it("releases each owned global listener on teardown", () => {
    const f = fixture();
    const add = vi.spyOn(f.host, "addEventListener");
    const remove = vi.spyOn(f.host, "removeEventListener");
    f.controller.start("preview");
    const owned = [...add.mock.calls];
    expect(owned).toHaveLength(7);
    f.controller.destroy();
    for (const args of owned) expect(remove.mock.calls).toContainEqual(args);
  });
});
