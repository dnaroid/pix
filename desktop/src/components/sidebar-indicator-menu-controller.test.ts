import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidebarIndicatorMenuController } from "./sidebar-indicator-menu-controller.svelte";

// Small deterministic DOM doubles: browser/native UI validation is a separate gate.
class Element {
  isConnected = true;
  focus = vi.fn(() => { dom.activeElement = this; });
  getBoundingClientRect = () => ({ right: 50, top: 20, width: 256, height: 120 });
  querySelectorAll = () => elements;
  contains = (element: unknown) => elements.includes(element as Element);
}
let elements: [Element, Element, Element];
const dom = { activeElement: null as Element | null };
function fixture() {
  elements = [new Element(), new Element(), new Element()];
  const trigger = new Element();
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("Node", Element);
  dom.activeElement = trigger;
  vi.stubGlobal("document", dom);
  vi.stubGlobal("window", { innerWidth: 600, innerHeight: 400 });
  const items = [{ label: "Disabled", disabled: true }, { label: "AI review" }, { label: "Inspect error" }];
  const controller = createSidebarIndicatorMenuController({ items: () => items });
  const menu = new Element();
  controller.state.element = menu as unknown as HTMLDivElement;
  const event = { clientX: 599, clientY: 399, currentTarget: trigger, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;
  const key = (key: string, target = elements[1]) => controller.keydown({ key, target, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);
  return { controller, trigger, menu, event, key, items };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("sidebar indicator menu lifecycle", () => {
  it("focuses the first enabled item and clamps the popup to the viewport", async () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    await vi.waitFor(() => expect(elements[1].focus).toHaveBeenCalled());
    expect(f.controller.state.position).toEqual({ left: 336, top: 272 });
    f.controller.dispose();
  });

  it("supports arrows, Home/End and typeahead while skipping disabled commands", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.controller.open(f.event, "idx");
    await Promise.resolve(); await Promise.resolve();
    f.key("ArrowUp");
    expect(elements[2].focus).toHaveBeenCalled();
    f.key("Home", elements[2]);
    expect(elements[1].focus).toHaveBeenCalled();
    f.key("End");
    expect(elements[2].focus).toHaveBeenCalledTimes(2);
    f.key("i");
    expect(elements[2].focus).toHaveBeenCalledTimes(3);
    expect(elements[0].focus).not.toHaveBeenCalled();
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["Escape", "Tab"])("dismisses on %s and returns focus to the trigger", (key) => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.key(key);
    expect(f.controller.state.tab).toBeNull();
    expect(f.trigger.focus).toHaveBeenCalled();
  });

  it("does not steal focus after close/dispose before the opening tick", async () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.controller.dispose();
    await Promise.resolve(); await Promise.resolve();
    expect(elements.every((element) => element.focus.mock.calls.length === 0)).toBe(true);
  });

  it("suppresses the native menu but opens no popup without reasons", () => {
    const f = fixture();
    f.items.splice(0);
    f.controller.open(f.event, "idx");
    expect(f.controller.state.tab).toBeNull();
    expect(f.event.preventDefault).toHaveBeenCalled();
  });

  it("dismisses only on an outside pointer", () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.controller.outside({ target: elements[1] } as unknown as PointerEvent);
    expect(f.controller.state.tab).toBe("idx");
    f.controller.outside({ target: new Element() } as unknown as PointerEvent);
    expect(f.controller.state.tab).toBeNull();
  });
});
