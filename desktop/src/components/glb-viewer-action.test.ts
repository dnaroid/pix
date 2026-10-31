import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLB_OFFSCREEN_RELEASE_MS, glbViewer, mountGlbViewer, mountViewportGlbViewer } from "./glb-viewer-action";

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), report: vi.fn() }));
vi.mock("../lib/diagnostic-logging", () => ({ createDiagnosticLogger: () => ({ report: mocks.report }) }));
vi.mock("../lib/glb-source", () => ({ readGlbSource: mocks.read }));
vi.mock("../lib/glb-scene", () => ({ createGlbScene: mocks.create }));

class Node {
  children: Node[] = [];
  parent?: Node;
  classList = { add: vi.fn() };
  className = "";
  textContent = "";
  disabled = false;
  listeners = new Map<string, () => void>();
  setAttribute() {}
  replaceChildren(...children: Node[]) { this.children = children; children.forEach((child) => { child.parent = this; }); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const host = () => new Node() as unknown as HTMLElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("document", { createElement: () => new Node() });
  vi.stubGlobal("fetch", vi.fn(async () => new Response()));
  mocks.read.mockResolvedValue(new ArrayBuffer(0));
  mocks.create.mockResolvedValue({ dispose: vi.fn(), reset: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("GLB viewer ownership", () => {
  it("enables reset only after load and disposes the scene on removal", async () => {
    const node = host();
    const dispose = mountGlbViewer(node, "asset:/chair.glb");
    const reset = node.children[2] as unknown as Node;
    expect(reset.disabled).toBe(true);
    await flush();
    expect(reset.disabled).toBe(false);
    const scene = await mocks.create.mock.results[0]!.value;
    reset.listeners.get("click")!();
    expect(scene.reset).toHaveBeenCalledOnce();
    dispose();
    expect(scene.dispose).toHaveBeenCalledOnce();
    expect(node.children).toHaveLength(0);
    expect(reset.listeners.size).toBe(0);
  });

  it("aborts fetch and ignores a read completing after teardown", async () => {
    const pending = deferred<ArrayBuffer>();
    mocks.read.mockReturnValue(pending.promise);
    const dispose = mountGlbViewer(host(), "asset:/chair.glb");
    await flush();
    const signal = mocks.read.mock.calls[0]![1] as AbortSignal;
    dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve(new ArrayBuffer(0));
    await flush();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("disposes a stale parse completion without enabling controls", async () => {
    const pending = deferred<{ dispose: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }>();
    mocks.create.mockReturnValue(pending.promise);
    const node = host();
    const dispose = mountGlbViewer(node, "asset:/chair.glb");
    const reset = node.children[2] as unknown as Node;
    await flush();
    expect(mocks.create).toHaveBeenCalledOnce();
    dispose();
    const scene = { dispose: vi.fn(), reset: vi.fn() };
    pending.resolve(scene);
    await flush();
    expect(scene.dispose).toHaveBeenCalledOnce();
    expect(reset.disabled).toBe(true);
    expect(node.children).toHaveLength(0);
  });

  it("leaves a readable error and disabled reset on failure", async () => {
    mocks.read.mockRejectedValue(new Error("external resources are disabled"));
    const node = host();
    const dispose = mountGlbViewer(node, "asset:/bad.glb");
    await flush();
    expect(node.children[1]!.textContent).toContain("external resources are disabled");
    expect((node.children[2] as unknown as Node).disabled).toBe(true);
    dispose();
  });

  it("retains an unchanged source and tears down the old request when switching", async () => {
    const action = glbViewer(host(), "asset:/one.glb");
    action.update("asset:/one.glb");
    expect(mocks.read).toHaveBeenCalledOnce();
    const signal = mocks.read.mock.calls[0]![1] as AbortSignal;
    action.update("asset:/two.glb");
    expect(signal.aborted).toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    action.destroy();
    await flush();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("GLB WebGL context budget", () => {
  beforeEach(() => mocks.create.mockImplementation(async () => ({ dispose: vi.fn(), reset: vi.fn() })));
  it("releases a lost context, logs it and reloads on demand", async () => {
    const node = host();
    const dispose = mountGlbViewer(node, "asset:/chair.glb");
    await flush();
    const scene = await mocks.create.mock.results[0]!.value;
    const options = mocks.create.mock.calls[0]![3] as { onContextLost: () => void };
    const firstSignal = mocks.create.mock.calls[0]![2] as AbortSignal;
    options.onContextLost();
    expect(scene.dispose).toHaveBeenCalledOnce();
    expect(firstSignal.aborted).toBe(true);
    expect(mocks.report).toHaveBeenCalledWith(expect.any(String), "media:playback-unavailable");
    const status = node.children[1] as unknown as Node;
    const button = node.children[2] as unknown as Node;
    expect(status.textContent).toContain("graphics context");
    expect(button.textContent).toBe("Reload 3D preview");
    expect(button.disabled).toBe(false);
    // A repeated (stale) loss notification for the released scene is ignored.
    options.onContextLost();
    expect(mocks.report).toHaveBeenCalledOnce();
    button.listeners.get("click")!();
    expect(button.disabled).toBe(true);
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(button.textContent).toBe("Reset camera");
    expect(button.disabled).toBe(false);
    const reloaded = await mocks.create.mock.results[1]!.value;
    dispose();
    expect(reloaded.dispose).toHaveBeenCalledOnce();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  describe("viewport-scoped viewer", () => {
    let notify!: (entries: { isIntersecting: boolean }[]) => void;
    const disconnect = vi.fn();
    beforeEach(() => {
      vi.useFakeTimers();
      disconnect.mockReset();
      vi.stubGlobal("IntersectionObserver", class {
        constructor(callback: typeof notify) { notify = callback; }
        observe() {} disconnect = disconnect;
      });
    });
    afterEach(() => vi.useRealTimers());

    it("mounts only near the viewport and releases the renderer after leaving it", async () => {
      const node = host();
      const destroy = mountViewportGlbViewer(node, "asset:/chair.glb");
      expect(mocks.read).not.toHaveBeenCalled();
      notify([{ isIntersecting: true }]);
      await flush();
      const scene = await mocks.create.mock.results[0]!.value;
      notify([{ isIntersecting: false }]);
      vi.advanceTimersByTime(GLB_OFFSCREEN_RELEASE_MS - 1);
      expect(scene.dispose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(scene.dispose).toHaveBeenCalledOnce();
      expect(node.children).toHaveLength(0);
      notify([{ isIntersecting: true }]);
      await flush();
      expect(mocks.create).toHaveBeenCalledTimes(2);
      destroy();
      expect(disconnect).toHaveBeenCalledOnce();
      expect((await mocks.create.mock.results[1]!.value).dispose).toHaveBeenCalledOnce();
    });

    it("keeps the viewer when it re-enters before the release delay and ignores late callbacks", async () => {
      const node = host();
      const destroy = mountViewportGlbViewer(node, "asset:/chair.glb");
      notify([{ isIntersecting: true }]);
      await flush();
      const scene = await mocks.create.mock.results[0]!.value;
      notify([{ isIntersecting: false }]);
      vi.advanceTimersByTime(GLB_OFFSCREEN_RELEASE_MS / 2);
      notify([{ isIntersecting: true }]);
      vi.advanceTimersByTime(GLB_OFFSCREEN_RELEASE_MS * 2);
      expect(scene.dispose).not.toHaveBeenCalled();
      expect(mocks.read).toHaveBeenCalledOnce();
      notify([{ isIntersecting: false }]);
      destroy();
      expect(scene.dispose).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(GLB_OFFSCREEN_RELEASE_MS * 2);
      notify([{ isIntersecting: true }]);
      await flush();
      expect(mocks.read).toHaveBeenCalledOnce();
      expect(scene.dispose).toHaveBeenCalledOnce();
    });
  });
});
