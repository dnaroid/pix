import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptMediaViewport } from "./transcript-media-viewport";

afterEach(() => vi.unstubAllGlobals());

describe("transcript media viewport", () => {
  it("tracks visible pane height, preserves hidden sizing and disconnects on teardown", () => {
    let notify: () => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const properties = new Map<string, string>();
    const node = {
      clientHeight: 640,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    };
    const action = transcriptMediaViewport(node as unknown as HTMLElement);
    expect(observe).toHaveBeenCalledWith(node);
    expect(properties.get("--chat-media-max-height")).toBe("640px");
    node.clientHeight = 420;
    notify();
    expect(properties.get("--chat-media-max-height")).toBe("420px");
    node.clientHeight = 0;
    notify();
    expect(properties.get("--chat-media-max-height")).toBe("420px");
    node.clientHeight = 800;
    notify();
    expect(properties.get("--chat-media-max-height")).toBe("800px");
    action.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    notify();
    expect(properties.size).toBe(0);
  });
});
