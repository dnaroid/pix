import { afterEach, describe, expect, it, vi } from "vitest";
import { activateModelPickerPopover, modelPickerPopoverPosition } from "./model-picker-popover";

describe("model picker nonmodal positioning", () => {
  it("sits directly above its invoker and clamps to the right edge", () => {
    expect(modelPickerPopoverPosition({ left: 1000, top: 760 }, 1200, 800))
      .toEqual({ left: 672, bottom: 40, width: 520, maxHeight: 730 });
  });

  it("fits narrow and short windows", () => {
    expect(modelPickerPopoverPosition({ left: 4, top: 200 }, 360, 240))
      .toEqual({ left: 8, bottom: 40, width: 344, maxHeight: 170 });
  });

  it("opens below a BTW header using its bottom edge without clipping the controls", () => {
    expect(modelPickerPopoverPosition({ left: 900, top: 48, bottom: 76 }, 1200, 800))
      .toEqual({ left: 672, top: 76, bottom: 8, width: 520, maxHeight: 716 });
    expect(modelPickerPopoverPosition({ left: 4, top: 40, bottom: 68 }, 360, 240))
      .toEqual({ left: 8, top: 68, bottom: 8, width: 344, maxHeight: 164 });
  });

  it("caps the full popup at window content height minus 70px", () => {
    expect(modelPickerPopoverPosition({ left: 8, top: 780 }, 1200, 800).maxHeight).toBe(730);
    expect(modelPickerPopoverPosition({ left: 8, top: 20 }, 360, 30).maxHeight).toBe(0);
  });
});

describe("model picker nonmodal lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(explicitInvoker = false) {
    class Element extends EventTarget {
      children = new Set<Element>();
      contains(target: unknown) { return target === this || this.children.has(target as Element); }
      focus = vi.fn();
      getBoundingClientRect() { return { left: 30, top: 760 }; }
    }
    const windowTarget = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800 });
    const trigger = new Element();
    const statusbarTrigger = new Element();
    const panel = new Element();
    const search = new Element();
    const body = new Element();
    panel.children.add(search);
    const documentTarget = { activeElement: search, body, querySelector: () => explicitInvoker ? statusbarTrigger : trigger };
    vi.stubGlobal("Node", Element);
    vi.stubGlobal("Element", Element);
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    const close = vi.fn();
    const position = vi.fn();
    const popover = activateModelPickerPopover(
      panel as unknown as HTMLDialogElement,
      search as unknown as HTMLInputElement,
      close, position, explicitInvoker ? trigger as unknown as HTMLButtonElement : undefined,
    );
    function pointer(target: Element) {
      const event = new Event("pointerdown");
      Object.defineProperty(event, "target", { value: target });
      windowTarget.dispatchEvent(event);
    }
    function focusout(target: Element) {
      documentTarget.activeElement = target;
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
    return { trigger, statusbarTrigger, panel, search, body, close, position, popover, windowTarget, pointer, focusout, escape, Element };
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

  it("allows focus inside the panel or on the trigger, and dismisses focus leaving both", async () => {
    const { focusout, search, trigger, close, popover, Element } = setup();
    focusout(search);
    focusout(trigger);
    expect(close).not.toHaveBeenCalled();
    focusout(new Element());
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(trigger.focus).not.toHaveBeenCalled();
    popover.dispose();
  });

  it("does not mutate state from teardown focusout or a stale focus departure", async () => {
    const h = setup();
    h.focusout(new h.Element());
    h.focusout(h.search);
    await Promise.resolve();
    expect(h.close).not.toHaveBeenCalled();
    h.focusout(new h.Element());
    h.popover.dispose();
    await Promise.resolve();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("focuses pointer-activated buttons before focusout can discard Apply and releases the listener", () => {
    const h = setup();
    const button = Object.assign(new h.Element(), { disabled: false });
    const icon = Object.assign(new h.Element(), { closest: () => button });
    h.panel.children.add(button);
    function press(mouseButton = 0) {
      const event = new Event("pointerdown");
      Object.defineProperties(event, { target: { value: icon }, button: { value: mouseButton } });
      h.panel.dispatchEvent(event);
    }
    press(2);
    expect(button.focus).not.toHaveBeenCalled();
    press();
    expect(button.focus).toHaveBeenCalledWith({ preventScroll: true });
    button.disabled = true;
    press();
    h.popover.dispose();
    button.disabled = false;
    press();
    expect(button.focus).toHaveBeenCalledOnce();
  });

  it("keeps an in-panel pointer blur to body alive until click but still dismisses keyboard departure", async () => {
    const h = setup();
    h.pointer(h.search);
    h.focusout(h.body);
    await Promise.resolve();
    expect(h.close).not.toHaveBeenCalled();
    const key = new Event("keydown");
    Object.defineProperty(key, "key", { value: "Tab" });
    h.windowTarget.dispatchEvent(key);
    h.focusout(h.body);
    await Promise.resolve();
    expect(h.close).toHaveBeenCalledOnce();
    h.popover.dispose();
  });

  it("an explicit BTW invoker owns positioning and Escape instead of the statusbar trigger", () => {
    const h = setup(true);
    h.pointer(h.trigger);
    expect(h.close).not.toHaveBeenCalled();
    h.escape();
    expect(h.trigger.focus).toHaveBeenCalledOnce();
    expect(h.statusbarTrigger.focus).not.toHaveBeenCalled();
    h.popover.dispose();
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
