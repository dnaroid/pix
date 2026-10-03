import { afterEach, describe, expect, it, vi } from "vitest";
import { activateModalDialog } from "./modal-dialog";

describe("modal focus teardown", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    class Element { focus = vi.fn(); }
    const invoker = new Element();
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("HTMLElement", Element);
    vi.stubGlobal("document", { activeElement: invoker });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    const dialog = {
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
    } as HTMLDialogElement;
    function flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    }
    return { invoker, dialog, flush };
  }

  it("restores the composer only after dialog close, without a competing invoker restore", () => {
    const { invoker, dialog, flush } = setup();
    const search = { focus: vi.fn() } as unknown as HTMLElement;
    const composer = vi.fn(() => expect(dialog.open).toBe(false));
    const dispose = activateModalDialog(dialog, () => search, composer);
    flush();
    expect(search.focus).toHaveBeenCalledOnce();
    dispose();
    expect(composer).not.toHaveBeenCalled();
    flush();
    expect(composer).toHaveBeenCalledOnce();
    expect(invoker.focus).not.toHaveBeenCalled();
  });

  it("cancels pending initial focus and preserves default invoker restoration", () => {
    const { invoker, dialog, flush } = setup();
    const initial = vi.fn();
    const dispose = activateModalDialog(dialog, initial);
    dispose();
    flush();
    expect(initial).not.toHaveBeenCalled();
    expect(invoker.focus).toHaveBeenCalledOnce();
  });
});
