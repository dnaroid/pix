import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glbViewer, mountGlbViewer } from "./glb-viewer-action";

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
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
