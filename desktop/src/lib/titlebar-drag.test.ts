import { afterEach, describe, expect, it, vi } from "vitest";
import { titlebarDrag } from "./titlebar-drag";

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging }) }));

describe("ordinary workbench titlebar dragging", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("starts native window movement only past the threshold and suppresses tab activation", () => {
    const host = Object.assign(new EventTarget(), { setTimeout: (callback: () => void) => callback() });
    const node = new EventTarget();
    vi.stubGlobal("window", host);
    const action = titlebarDrag(node as HTMLElement);
    const send = (target: EventTarget, type: string, props: Record<string, number> = {}) => {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, { button: 0, clientX: 10, clientY: 10, ...props });
      target.dispatchEvent(event);
      return event;
    };
    send(node, "pointerdown");
    send(host, "pointermove", { clientX: 12 });
    expect(startDragging).not.toHaveBeenCalled();
    send(host, "pointermove", { clientX: 20 });
    expect(startDragging).toHaveBeenCalledOnce();
    expect(send(node, "click").defaultPrevented).toBe(true);
    send(host, "pointerup");
    expect(send(node, "click").defaultPrevented).toBe(false);
    action.destroy();
    send(node, "pointerdown");
    send(host, "pointermove", { clientX: 50 });
    expect(startDragging).toHaveBeenCalledOnce();
  });
});
