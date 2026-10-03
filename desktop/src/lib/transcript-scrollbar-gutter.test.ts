import { afterEach, describe, expect, it, vi } from "vitest";
import { observeTranscriptScrollbarGutter } from "./transcript-scrollbar-gutter";

afterEach(() => vi.unstubAllGlobals());

describe("transcript scrollbar gutter", () => {
  it("tracks classic, overlay and disappearing scrollbar widths and disconnects safely", () => {
    let resize = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const pane = { offsetWidth: 960, clientWidth: 950 } as HTMLElement;
    const changed = vi.fn();
    const dispose = observeTranscriptScrollbarGutter(pane, changed);
    expect(observe).toHaveBeenCalledWith(pane);
    expect(changed).toHaveBeenLastCalledWith(10);
    Object.assign(pane, { clientWidth: 954 });
    resize();
    expect(changed).toHaveBeenLastCalledWith(6);
    Object.assign(pane, { clientWidth: 960 });
    resize();
    expect(changed).toHaveBeenLastCalledWith(0);
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    changed.mockClear();
    resize();
    expect(changed).not.toHaveBeenCalled();
  });
});
