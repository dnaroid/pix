import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { Menu } from "@tauri-apps/api/menu";
import { createProjectExplorerMenuController } from "./project-explorer-menu-controller.svelte";
import type { ProjectTreeEntry } from "../lib/project-tree";

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));

const entry: ProjectTreeEntry = { name: "src", path: "src", kind: "directory" };

function fixture(width = 440, height = 440, native = false) {
  class TestElement {
    isConnected = true;
    focus = vi.fn();
    getBoundingClientRect() { return { left: 30, bottom: 420 }; }
  }
  const observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("HTMLElement", TestElement);
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("window", {
    innerWidth: width, innerHeight: height, clearTimeout: vi.fn(),
    addEventListener: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeEventListener: vi.fn((event: string) => listeners.delete(event)),
  });
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: () => void) { observers.push({ callback, disconnect: this.disconnect }); }
  });
  const trigger = new TestElement();
  const controller = createProjectExplorerMenuController({
    items: () => [{ label: "Open" }, { label: "Delete" }],
    native: native ? { items: () => [{ id: "open", label: "Open", action: vi.fn() }], prepare: async () => {}, reportError: vi.fn() } : undefined,
  });
  let size = { width: 224, height: 400 };
  const buttons = [{ focus: vi.fn() }, { focus: vi.fn() }];
  const element = {
    getBoundingClientRect: () => size,
    querySelectorAll: () => buttons,
  } as unknown as HTMLDivElement;
  controller.state.menuElement = element;
  function open(x = 420, y = 420) {
    controller.openContextMenu({
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      currentTarget: trigger, clientX: x, clientY: y,
    } as unknown as MouseEvent, entry);
  }
  return { controller, open, element, observers, trigger, buttons, listeners, setSize: (next: typeof size) => { size = next; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("Project Explorer measured context-menu placement", () => {
  it("uses unclamped native coordinates, row focus and teardown rather than DOM rendering", async () => {
    const native = { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(Menu.new).mockResolvedValue(native as unknown as Menu);
    const f = fixture(440, 440, true);
    const uninstall = f.controller.installNativeCancellation();
    f.open(420, 420);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.controller.state.position).toBeNull();
    expect(f.trigger.focus).toHaveBeenCalled();
    expect(native.popup).toHaveBeenLastCalledWith(expect.objectContaining({ x: 420, y: 420 }));
    f.listeners.get("blur")!();
    expect(native.close).not.toHaveBeenCalled();
    f.open(0, 0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(native.popup).toHaveBeenLastCalledWith(expect.objectContaining({ x: 42, y: 420 }));
    uninstall();
    expect(f.listeners.size).toBe(0);
    f.controller.dispose();
  });

  it("cancels a delayed native popup on intervening keyboard interaction", async () => {
    vi.mocked(Menu.new).mockClear();
    const f = fixture(440, 440, true);
    const uninstall = f.controller.installNativeCancellation();
    f.open();
    f.listeners.get("keydown")!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(Menu.new).not.toHaveBeenCalled();
    expect(f.controller.state.entry).toBeNull();
    uninstall();
    f.controller.dispose();
  });
  it("keeps a tall folder menu inside the bottom and right edges", async () => {
    const f = fixture();
    f.open();
    const action = f.controller.observeMenu(f.element);
    await tick();
    expect(f.controller.state.position).toEqual({ left: 208, top: 32 });
    expect(f.buttons[0]!.focus).toHaveBeenCalledOnce();
    action.destroy();
    f.controller.dispose();
  });

  it("reclamps when late commands increase height, and returns to the anchor on shrink", () => {
    const f = fixture(800, 600);
    f.setSize({ width: 224, height: 160 });
    f.open(100, 300);
    const action = f.controller.observeMenu(f.element);
    expect(f.controller.state.position).toEqual({ left: 100, top: 300 });
    f.setSize({ width: 224, height: 420 });
    f.observers[0]!.callback();
    expect(f.controller.state.position).toEqual({ left: 100, top: 172 });
    f.setSize({ width: 224, height: 160 });
    f.observers[0]!.callback();
    expect(f.controller.state.position).toEqual({ left: 100, top: 300 });
    action.destroy();
    f.controller.dispose();
  });

  it("anchors keyboard opening to the row and clamps top/left clicks", () => {
    const f = fixture();
    f.open(0, 0);
    const action = f.controller.observeMenu(f.element);
    expect(f.controller.state.position).toEqual({ left: 42, top: 32 });
    f.open(-10, -20);
    f.observers[0]!.callback();
    expect(f.controller.state.position).toEqual({ left: 8, top: 8 });
    action.destroy();
    f.controller.dispose();
  });

  it("fits a viewport-sized scrollable menu at the margin", () => {
    const f = fixture(200, 300);
    // CSS caps the rendered dimensions to the viewport minus both margins.
    f.setSize({ width: 184, height: 284 });
    f.open();
    const action = f.controller.observeMenu(f.element);
    expect(f.controller.state.position).toEqual({ left: 8, top: 8 });
    action.destroy();
    f.controller.dispose();
  });

  it("remeasures a reused menu on replacement and only focuses the latest request", async () => {
    const f = fixture();
    f.open();
    const action = f.controller.observeMenu(f.element);
    f.setSize({ width: 224, height: 120 });
    f.open(50, 100);
    await tick();
    expect(f.controller.state.position).toEqual({ left: 50, top: 100 });
    expect(f.buttons[0]!.focus).toHaveBeenCalledOnce();
    action.destroy();
    f.controller.dispose();
  });

  it("cancels pending focus on close/resize/disposal and disconnects the observer", async () => {
    const f = fixture();
    f.open();
    const action = f.controller.observeMenu(f.element);
    f.controller.handleWindowResize();
    await tick();
    expect(f.controller.state.position).toBeNull();
    expect(f.buttons[0]!.focus).not.toHaveBeenCalled();
    f.observers[0]!.callback();
    expect(f.controller.state.position).toBeNull();
    f.open();
    f.controller.dispose();
    await tick();
    expect(f.buttons[0]!.focus).not.toHaveBeenCalled();
    expect(f.observers[0]!.disconnect).toHaveBeenCalled();
    action.destroy();
  });

  it("ignores a destroyed observer after another menu opens", () => {
    const f = fixture();
    f.open();
    const action = f.controller.observeMenu(f.element);
    action.destroy();
    f.open(100, 100);
    const before = f.controller.state.position;
    f.observers[0]!.callback();
    expect(f.controller.state.position).toBe(before);
    f.controller.close(true);
    expect(f.trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    f.controller.dispose();
  });
});
