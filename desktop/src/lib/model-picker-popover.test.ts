import { afterEach, describe, expect, it, vi } from "vitest";
import { activateModelPickerPopover, modelPickerPopoverPosition } from "./model-picker-popover";

describe("model picker nonmodal positioning", () => {
  it("sits directly above its invoker and clamps to the right edge", () => {
    expect(modelPickerPopoverPosition({ left: 1000, top: 760 }, 1200, 800))
      .toEqual({ left: 672, bottom: 40, width: 520, maxHeight: 600 });
  });

  it("fits narrow and short windows", () => {
    expect(modelPickerPopoverPosition({ left: 4, top: 200 }, 360, 240))
      .toEqual({ left: 8, bottom: 40, width: 344, maxHeight: 192 });
  });
});

describe("model picker nonmodal lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    class Element extends EventTarget {
      children = new Set<Element>();
      contains(target: unknown) { return target === this || this.children.has(target as Element); }
      focus = vi.fn();
      getBoundingClientRect() { return { left: 30, top: 760 }; }
    }
    const windowTarget = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800 });
    const trigger = new Element();
    const panel = new Element();
    const search = new Element();
    panel.children.add(search);
    const documentTarget = { activeElement: search, querySelector: () => trigger };
    vi.stubGlobal("Node", Element);
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    const close = vi.fn();
    const position = vi.fn();
    const popover = activateModelPickerPopover(
      panel as unknown as HTMLDialogElement,
      search as unknown as HTMLInputElement,
      close, position,
    );
    function pointer(target: Element) {
      const event = new Event("pointerdown");
      Object.defineProperty(event, "target", { value: target });
      windowTarget.dispatchEvent(event);
    }
    function focusout(target: Element) {
      const event = new Event("focusout");
      Object.defineProperty(event, "relatedTarget", { value: target });
      panel.dispatchEvent(event);
    }
    function escape() {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperty(event, "key", { value: "Escape" });
      windowTarget.dispatchEvent(event);
      return event;
    }
    return { trigger, panel, search, close, position, popover, windowTarget, pointer, focusout, escape, Element };
  }

  it("focuses search without modal activation, traps or pointer-leave dismissal", () => {
    const { search, panel, trigger, close, pointer, popover } = setup();
    expect(search.focus).toHaveBeenCalledOnce();
    pointer(search);
    pointer(trigger); // Let the trigger's own toggle handle repeat activation.
    panel.dispatchEvent(new Event("pointerleave"));
    expect(close).not.toHaveBeenCalled();
    popover.dispose();
  });

  it("dismisses outside interaction without stealing the destination's focus", () => {
    const { pointer, close, trigger, popover, Element } = setup();
    pointer(new Element());
    expect(close).toHaveBeenCalledOnce();
    expect(trigger.focus).not.toHaveBeenCalled();
    popover.dispose();
  });

  it("allows focus inside the panel or on the trigger, and dismisses focus leaving both", () => {
    const { focusout, search, trigger, close, popover, Element } = setup();
    focusout(search);
    focusout(trigger);
    expect(close).not.toHaveBeenCalled();
    focusout(new Element());
    expect(close).toHaveBeenCalledOnce();
    expect(trigger.focus).not.toHaveBeenCalled();
    popover.dispose();
  });

  it("Escape restores trigger focus and teardown releases every listener", () => {
    const { escape, pointer, focusout, trigger, close, position, popover, windowTarget, Element } = setup();
    expect(escape().defaultPrevented).toBe(true);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    windowTarget.dispatchEvent(new Event("resize"));
    expect(position).toHaveBeenCalledTimes(2);
    popover.dispose();
    escape();
    pointer(new Element());
    focusout(new Element());
    windowTarget.dispatchEvent(new Event("resize"));
    popover.close();
    expect(close).toHaveBeenCalledOnce();
    expect(position).toHaveBeenCalledTimes(2);
  });
});
