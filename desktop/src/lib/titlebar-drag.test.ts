import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { titlebarDrag, titlebarRegionDrag } from "./titlebar-drag";
import titlebarSource from "../components/DesktopTitlebar.svelte?raw";
import tabsSource from "../components/WorkbenchTabs.svelte?raw";

const { startDragging, report } = vi.hoisted(() => ({ startDragging: vi.fn(), report: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging }) }));
vi.mock("./diagnostic-logging", () => ({ createDiagnosticLogger: () => ({ warn: report }) }));

function send(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, {
    button: 0, buttons: 1, pointerId: 1, isPrimary: true, detail: 1,
    clientX: 10, clientY: 10, screenX: 100, screenY: 100, ...props,
  });
  target.dispatchEvent(event);
  return event;
}

describe("workbench titlebar dragging", () => {
  let host: EventTarget;
  const actions: { destroy: () => void }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    startDragging.mockResolvedValue(undefined);
    host = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
    vi.stubGlobal("window", host);
  });

  afterEach(() => {
    actions.splice(0).forEach(action => action.destroy());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function mount(region = false) {
    const node = new EventTarget();
    const action = (region ? titlebarRegionDrag : titlebarDrag)(node as HTMLElement);
    actions.push(action);
    return { node, action };
  }

  it.each([false, true])("starts one native drag past the threshold (empty region: %s)", (region) => {
    const { node } = mount(region);
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 103 });
    expect(startDragging).not.toHaveBeenCalled();
    const move = send(host, "pointermove", { screenX: 104 });
    expect(move.defaultPrevented).toBe(true);
    send(host, "pointermove", { screenX: 110 });
    expect(startDragging).toHaveBeenCalledOnce();
    expect(send(node, "click").defaultPrevented).toBe(true);
    send(host, "pointerup");
    // The click in the same event turn must still be suppressed.
    expect(send(node, "click").defaultPrevented).toBe(true);
    vi.runAllTimers();
    expect(send(node, "click").defaultPrevented).toBe(false);
  });

  it("does not start native dragging on an activating click or later hover", () => {
    const { node } = mount(true);
    send(node, "pointerdown");
    const mouse = send(node, "mousedown");
    // Blocks Tauri's document-level mousedown drag handler.
    expect(mouse.cancelBubble).toBe(true);
    expect(mouse.defaultPrevented).toBe(true);
    send(host, "pointerup");
    send(host, "pointermove", { screenX: 500, buttons: 0 });
    expect(startDragging).not.toHaveBeenCalled();
    expect(send(node, "click").defaultPrevented).toBe(false);
  });

  it("ignores activation-induced client coordinate changes without screen movement", () => {
    const { node } = mount(true);
    send(node, "pointerdown");
    send(host, "pointermove", { clientX: 300, clientY: 200 });
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("cancels tracking if the pointer is no longer pressed even without pointerup", () => {
    const { node } = mount();
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 400, buttons: 0 });
    send(host, "pointermove", { screenX: 500 });
    expect(startDragging).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "blur"])("cancels a pending gesture on %s", (type) => {
    const { node } = mount(true);
    send(node, "pointerdown");
    send(host, type);
    send(host, "pointermove", { screenX: 500 });
    expect(startDragging).not.toHaveBeenCalled();
    expect(send(node, "click").defaultPrevented).toBe(false);
  });

  it("tracks only the primary pointer and ignores another pointer's movement/release", () => {
    const { node } = mount();
    send(node, "pointerdown", { button: 1 });
    send(host, "pointermove", { screenX: 500 });
    send(node, "pointerdown", { isPrimary: false });
    send(host, "pointermove", { screenX: 500 });
    expect(startDragging).not.toHaveBeenCalled();
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 500, pointerId: 2 });
    send(host, "pointerup", { pointerId: 2 });
    send(host, "pointercancel", { pointerId: 2 });
    expect(startDragging).not.toHaveBeenCalled();
    send(host, "pointermove", { screenX: 110 });
    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("does not intercept descendant controls or start duplicate region drags", () => {
    const { node } = mount(true);
    const child = new EventTarget();
    const down = new Event("pointerdown");
    Object.defineProperty(down, "target", { value: child });
    Object.assign(down, { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
    node.dispatchEvent(down);
    const mouse = new Event("mousedown", { cancelable: true });
    Object.defineProperty(mouse, "target", { value: child });
    Object.assign(mouse, { button: 0, detail: 1 });
    node.dispatchEvent(mouse);
    send(host, "pointermove", { screenX: 500 });
    expect(startDragging).not.toHaveBeenCalled();
    expect(mouse.defaultPrevented).toBe(false);
  });

  it("preserves Tauri's double-click path without starting a threshold drag", () => {
    const { node } = mount(true);
    send(node, "pointerdown");
    const mouse = send(node, "mousedown", { detail: 2 });
    expect(mouse.defaultPrevented).toBe(false);
    send(host, "pointermove", { screenX: 500 });
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("logs native failures and restores click activation", async () => {
    const error = new Error("native drag failed");
    startDragging.mockRejectedValueOnce(error);
    const { node } = mount();
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 110 });
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith("frontend:titlebar-drag", error);
    expect(send(node, "click").defaultPrevented).toBe(false);
  });

  it("does not let a stale failure or click-reset timer affect a later drag", async () => {
    let reject!: (error: Error) => void;
    startDragging.mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail; }));
    const { node } = mount();
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 110 });
    send(host, "pointerup");
    send(node, "pointerdown");
    send(host, "pointermove", { screenX: 120 });
    reject(new Error("old gesture failed"));
    await Promise.resolve();
    vi.runAllTimers();
    expect(send(node, "click").defaultPrevented).toBe(true);
  });

  it("removes listeners and pending timers on teardown", () => {
    const { node, action } = mount(true);
    send(node, "pointerdown");
    send(host, "pointerup");
    expect(vi.getTimerCount()).toBe(1);
    action.destroy();
    expect(vi.getTimerCount()).toBe(0);
    send(node, "pointerdown");
    const mouse = send(node, "mousedown");
    send(host, "pointermove", { screenX: 500 });
    expect(mouse.defaultPrevented).toBe(false);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("gates every empty titlebar region while retaining native zoom attributes", () => {
    for (const source of [titlebarSource, tabsSource]) {
      const regions = source.match(/<[^>]*\bdata-tauri-drag-region\b[^>]*>/g) ?? [];
      expect(regions.length).toBeGreaterThan(0);
      for (const region of regions) expect(region).toContain("use:titlebarRegionDrag");
    }
  });
});
