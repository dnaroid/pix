import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { desktopContextTarget, focusContextTarget } from "./desktop-context-target";
import { installDesktopContextMenu } from "./desktop-context-menu";
import type { DesktopContextTarget } from "./desktop-context-target";
import type { NativeContextMenu } from "./native-context-menu";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => true) }));
vi.mock("./desktop-context-target", () => ({ contextElement: vi.fn(), desktopContextTarget: vi.fn(), focusContextTarget: vi.fn() }));
vi.mock("./native-context-menu", () => ({ createNativeContextMenuFactory: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function menu(): NativeContextMenu { return { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }; }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const context: DesktopContextTarget = {
  kind: "editable", hasSelection: true, readOnly: false, editor: null,
  element: { isConnected: true, getBoundingClientRect: () => ({ left: 12, bottom: 45 }) } as unknown as HTMLElement,
};

describe("desktop context menu lifecycle", () => {
  let target: EventTarget;
  let dispose: (() => void) | undefined;
  const reportError = vi.fn();
  function rightClick(x = 50, y = 70) {
    const event = Object.assign(new Event("contextmenu", { cancelable: true }), { clientX: x, clientY: y });
    target.dispatchEvent(event);
    return event;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    target = new EventTarget();
    vi.stubGlobal("window", target);
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(desktopContextTarget).mockReturnValue(context);
  });
  afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });

  it("suppresses browser chrome synchronously, even where no application commands exist", () => {
    vi.mocked(desktopContextTarget).mockReturnValue(null);
    const createMenu = vi.fn();
    dispose = installDesktopContextMenu({ reportError, createMenu });
    expect(rightClick().defaultPrevented).toBe(true);
    expect(createMenu).not.toHaveBeenCalled();
  });
  it("preserves focused native text editing and uses logical pointer coordinates", async () => {
    const native = menu();
    dispose = installDesktopContextMenu({ reportError, createMenu: async () => native });
    rightClick();
    await flush();
    expect(focusContextTarget).toHaveBeenCalledWith(context);
    expect(native.popup).toHaveBeenCalledWith({ x: 50, y: 70 });
    expect(native.close).not.toHaveBeenCalled(); // GTK popup is not a dismissal promise.
  });
  it("anchors a keyboard context request to the focused target", async () => {
    const native = menu();
    dispose = installDesktopContextMenu({ reportError, createMenu: async () => native });
    rightClick(0, 0);
    await flush();
    expect(native.popup).toHaveBeenCalledWith({ x: 20, y: 45 });
  });
  it.each(["pointerdown", "input", "focusin", "blur", "resize", "scroll"])("cancels a pending menu after %s", async (name) => {
    const pending = deferred<NativeContextMenu>();
    const native = menu();
    dispose = installDesktopContextMenu({ reportError, createMenu: () => pending.promise });
    rightClick();
    target.dispatchEvent(new Event(name));
    pending.resolve(native);
    await flush();
    expect(native.popup).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("closes out-of-order creations without replacing the newer menu", async () => {
    const first = deferred<NativeContextMenu>();
    const stale = menu();
    const current = menu();
    const createMenu = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(current);
    dispose = installDesktopContextMenu({ reportError, createMenu });
    rightClick();
    rightClick(90, 100);
    await flush();
    first.resolve(stale);
    await flush();
    expect(current.popup).toHaveBeenCalledWith({ x: 90, y: 100 });
    expect(stale.popup).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledOnce();
  });
  it("releases the previous native resource before replacement and invalidates its callbacks", async () => {
    const first = menu();
    const second = menu();
    const callbacks: (() => boolean)[] = [];
    const createMenu = vi.fn(async (_context, isActive: () => boolean) => {
      callbacks.push(isActive);
      return callbacks.length === 1 ? first : second;
    });
    dispose = installDesktopContextMenu({ reportError, createMenu });
    rightClick(); await flush();
    expect(callbacks[0]?.()).toBe(true);
    rightClick(); await flush();
    expect(callbacks[0]?.()).toBe(false);
    expect(callbacks[1]?.()).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
  });
  it("releases a creation completing after unmount and removes suppression listeners", async () => {
    const pending = deferred<NativeContextMenu>();
    const native = menu();
    dispose = installDesktopContextMenu({ reportError, createMenu: () => pending.promise });
    rightClick();
    dispose(); dispose = undefined;
    pending.resolve(native); await flush();
    expect(native.popup).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    expect(rightClick().defaultPrevented).toBe(false);
  });
  it("reports popup failure and releases the failed native menu", async () => {
    const native = menu();
    vi.mocked(native.popup).mockRejectedValueOnce(new Error("popup denied"));
    dispose = installDesktopContextMenu({ reportError, createMenu: async () => native });
    rightClick(); await flush();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "popup denied" }));
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("does not release a resource twice if its popup rejects after replacement", async () => {
    const popup = deferred<void>();
    const old = menu();
    vi.mocked(old.popup).mockReturnValue(popup.promise);
    const current = menu();
    const createMenu = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(current);
    dispose = installDesktopContextMenu({ reportError, createMenu });
    rightClick(); await flush();
    rightClick(); await flush();
    popup.reject(new Error("old popup cancelled")); await flush();
    expect(old.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
  it("does not suppress the independent browser preview", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    dispose = installDesktopContextMenu({ reportError });
    expect(rightClick().defaultPrevented).toBe(false);
  });
});
