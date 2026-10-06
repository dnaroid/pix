import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGlbScene } from "./glb-scene";

const mocks = vi.hoisted(() => ({ parse: vi.fn(), manager: vi.fn(), renderer: vi.fn(), controls: vi.fn() }));
vi.mock("three", async (original) => ({
  ...await original<object>(), WebGLRenderer: class { constructor() { return mocks.renderer(); } },
}));
vi.mock("three/addons/controls/OrbitControls.js", () => ({
  OrbitControls: class { constructor() { return mocks.controls(); } },
}));
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class { constructor(manager: THREE.LoadingManager) { mocks.manager(manager); } parseAsync = mocks.parse; },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

function visibleSceneFixture() {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  mocks.parse.mockResolvedValue({ scene, scenes: [scene] });
  const canvas = { style: {}, setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn() };
  const renderer = { domElement: canvas, setPixelRatio: vi.fn(), setSize: vi.fn(), render: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn() };
  const controls = { target: new THREE.Vector3(), update: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispose: vi.fn() };
  mocks.renderer.mockReturnValue(renderer);
  mocks.controls.mockReturnValue(controls);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }));
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  let resize!: () => void;
  const resizeDisconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect = resizeDisconnect;
  });
  let visibility!: (entries: { isIntersecting: boolean }[]) => void;
  const visibilityDisconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof visibility) { visibility = callback; }
    observe() {} disconnect = visibilityDisconnect;
  });
  const host = { append: vi.fn(), isConnected: true, clientWidth: 600, clientHeight: 400 };
  return {
    host, renderer, controls, frames, cancelFrame, resizeDisconnect, visibilityDisconnect,
    resize: () => resize(),
    visible: (value: boolean) => visibility([{ isIntersecting: value }]),
    paint() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

describe("GLB retained viewer visibility", () => {
  it("redraws after Preview closes without reloading the model or resetting its camera", async () => {
    const fixture = visibleSceneFixture();
    const viewer = await createGlbScene(fixture.host as unknown as HTMLElement, new ArrayBuffer(0), new AbortController().signal);
    expect(fixture.renderer.render).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(1);
    fixture.paint();
    const camera = fixture.renderer.render.mock.calls[0]![1] as THREE.PerspectiveCamera;
    camera.position.set(2, 3, 4);
    const target = fixture.controls.target.clone();
    fixture.host.clientWidth = fixture.host.clientHeight = 0;
    fixture.visible(false);
    fixture.resize();
    expect(fixture.renderer.setSize).toHaveBeenCalledTimes(1);
    expect(fixture.frames.size).toBe(0);
    // Becoming visible must repaint even if no resize notification is delivered.
    fixture.host.clientWidth = 600;
    fixture.host.clientHeight = 400;
    fixture.visible(true);
    expect(fixture.renderer.render).toHaveBeenCalledTimes(1);
    fixture.paint();
    expect(fixture.renderer.render).toHaveBeenCalledTimes(2);
    expect(camera.position.toArray()).toEqual([2, 3, 4]);
    expect(fixture.controls.target.equals(target)).toBe(true);
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.renderer).toHaveBeenCalledOnce();
    viewer?.dispose();
  });

  it("coalesces demand drawing and cancels pending work on teardown", async () => {
    const fixture = visibleSceneFixture();
    const viewer = await createGlbScene(fixture.host as unknown as HTMLElement, new ArrayBuffer(0), new AbortController().signal);
    fixture.paint();
    fixture.visible(true);
    fixture.resize();
    viewer?.reset();
    expect(fixture.frames.size).toBe(1);
    const lateFrame = [...fixture.frames.values()][0]!;
    viewer?.dispose();
    expect(fixture.cancelFrame).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
    expect(fixture.resizeDisconnect).toHaveBeenCalledOnce();
    expect(fixture.visibilityDisconnect).toHaveBeenCalledOnce();
    lateFrame(0);
    fixture.visible(true);
    fixture.resize();
    expect(fixture.frames.size).toBe(0);
    expect(fixture.renderer.render).toHaveBeenCalledOnce();
  });
});

describe("GLB scene late parse cleanup", () => {
  it("rejects a missing default scene before allocating WebGL", async () => {
    mocks.parse.mockResolvedValue({ scenes: [] });
    await expect(createGlbScene({} as HTMLElement, new ArrayBuffer(0), new AbortController().signal)).rejects.toThrow("no default scene");
    expect(mocks.renderer).not.toHaveBeenCalled();
  });
  it("revokes loader-created embedded image URLs on failed parse and rejects late resource reads", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let manager!: THREE.LoadingManager;
    mocks.manager.mockImplementation((value) => { manager = value; });
    mocks.parse.mockImplementation(async () => {
      manager.resolveURL("blob:failed-texture");
      throw new Error("bad texture");
    });
    await expect(createGlbScene({} as HTMLElement, new ArrayBuffer(0), new AbortController().signal)).rejects.toThrow("bad texture");
    expect(revoke).toHaveBeenCalledWith("blob:failed-texture");
    expect(() => manager.resolveURL("blob:late-texture")).toThrow("Aborted");
    expect(() => manager.resolveURL("data:image/png;base64,AAAA")).toThrow("Aborted");
    expect(revoke).toHaveBeenCalledWith("blob:late-texture");
    revoke.mockRestore();
  });
  it("rejects late embedded data reads after owner abort while parsing is pending", async () => {
    const abort = new AbortController();
    let manager!: THREE.LoadingManager;
    mocks.manager.mockImplementation((value) => { manager = value; });
    let reject!: (reason: Error) => void;
    mocks.parse.mockImplementation(() => new Promise((_resolve, rejectParse) => { reject = rejectParse; }));
    const pending = createGlbScene({} as HTMLElement, new ArrayBuffer(0), abort.signal);
    abort.abort();
    expect(() => manager.resolveURL("data:image/png;base64,AAAA")).toThrow("Aborted");
    reject(new Error("aborted parse"));
    await expect(pending).rejects.toThrow("aborted parse");
  });
  it("releases canvas, controls, listeners and GPU resources when later initialization fails", async () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, material));
    const geometryDispose = vi.spyOn(geometry, "dispose");
    mocks.parse.mockResolvedValue({ scene, scenes: [scene] });
    const canvas = { style: {}, setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn() };
    const renderer = { domElement: canvas, setPixelRatio: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn() };
    const controls = { target: new THREE.Vector3(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispose: vi.fn() };
    mocks.renderer.mockReturnValue(renderer);
    mocks.controls.mockReturnValue(controls);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { disconnect = disconnect; observe() { throw new Error("observer failed"); } });
    await expect(createGlbScene({ append: vi.fn() } as unknown as HTMLElement, new ArrayBuffer(0), new AbortController().signal)).rejects.toThrow("observer failed");
    for (const release of [geometryDispose, canvas.remove, renderer.dispose, renderer.forceContextLoss, controls.dispose, disconnect]) {
      expect(release).toHaveBeenCalledOnce();
    }
    expect(canvas.removeEventListener).toHaveBeenCalledOnce();
    expect(controls.removeEventListener).toHaveBeenCalledOnce();
  });
  it("does not begin parsing for an already canceled owner", async () => {
    mocks.parse.mockClear();
    const abort = new AbortController();
    abort.abort();
    expect(await createGlbScene({} as HTMLElement, new ArrayBuffer(0), abort.signal)).toBeUndefined();
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("disposes all scenes' shared resources once if canceled during parse", async () => {
    const geometry = new THREE.BoxGeometry();
    const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const first = new THREE.Group(), second = new THREE.Group();
    first.add(new THREE.Mesh(geometry, material));
    second.add(new THREE.Mesh(geometry, material));
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const textureDispose = vi.spyOn(texture, "dispose");
    let complete!: (value: unknown) => void;
    mocks.parse.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const abort = new AbortController();
    const pending = createGlbScene({} as HTMLElement, new ArrayBuffer(0), abort.signal);
    abort.abort();
    complete({ scene: first, scenes: [first, second] });
    expect(await pending).toBeUndefined();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });
});
