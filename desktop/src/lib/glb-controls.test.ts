import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGlbControls, rotateGlbCamera } from "./glb-controls";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const windowTarget = Object.assign(new EventTarget(), { pageXOffset: 0, pageYOffset: 0 });
  vi.stubGlobal("window", windowTarget);
  const documentTarget = Object.assign(new EventTarget(), { documentElement: { clientLeft: 0, clientTop: 0 } });
  const canvas = Object.assign(new EventTarget(), {
    style: {}, ownerDocument: documentTarget, clientWidth: 600, clientHeight: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
  });
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.01, 1000);
  camera.position.set(0, 0, 5);
  const draw = vi.fn();
  const controller = createGlbControls(camera, canvas as unknown as HTMLCanvasElement, draw);
  function pointer(target: EventTarget, type: string, button: number, x: number, y: number) {
    target.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType: "mouse", button, pageX: x, pageY: y }));
  }
  return { camera, canvas, documentTarget, windowTarget, draw, get controls() { return controller.controls; }, dispose: controller.dispose, pointer };
}

describe("GLB unrestricted camera controls", () => {
  it("drags through both poles for a full revolution without changing distance or target", () => {
    const f = fixture();
    f.pointer(f.canvas, "pointerdown", 0, 300, 200);
    for (let step = 1; step <= 16; step++) {
      f.pointer(f.documentTarget, "pointermove", 0, 300, 200 - step * 300 * Math.PI / 8);
      f.controls.update();
      expect(f.camera.position.length()).toBeCloseTo(5);
      expect(f.controls.target.length()).toBe(0);
      if (step === 8) {
        expect(f.camera.position.z).toBeCloseTo(-5);
        expect(f.camera.up.y).toBeCloseTo(-1);
      }
    }
    expect(f.camera.position.distanceTo(new THREE.Vector3(0, 0, 5))).toBeCloseTo(0);
    expect(f.camera.up.distanceTo(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0);
    f.pointer(f.documentTarget, "pointerup", 0, 300, 200);
    f.dispose();
  });

  it("keeps middle dragging as pan and wheel scrolling as zoom, even upside down", () => {
    const f = fixture();
    rotateGlbCamera(f.camera, f.controls.target, 0, Math.PI);
    const offset = f.camera.position.clone().sub(f.controls.target);
    f.pointer(f.canvas, "pointerdown", 1, 300, 200);
    f.pointer(f.documentTarget, "pointermove", 1, 350, 240);
    f.controls.update();
    expect(f.controls.target.length()).toBeGreaterThan(0);
    expect(f.camera.position.clone().sub(f.controls.target).distanceTo(offset)).toBeCloseTo(0);
    f.pointer(f.documentTarget, "pointerup", 1, 350, 240);
    const target = f.controls.target.clone();
    f.canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { deltaMode: 0, deltaY: 100 }));
    f.controls.update();
    expect(f.camera.position.distanceTo(target)).toBeGreaterThan(5);
    expect(f.controls.target.equals(target)).toBe(true);
    expect(f.camera.up.y).toBeCloseTo(-1);
    f.dispose();
  });

  it("keyboard rotation also crosses the poles and completes a full revolution", () => {
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(1, 2, 3);
    camera.position.copy(target).add(new THREE.Vector3(0, 0, 5));
    for (let step = 1; step <= 16; step++) {
      rotateGlbCamera(camera, target, 0, Math.PI / 8);
      expect(camera.position.distanceTo(target)).toBeCloseTo(5);
      if (step === 8) expect(camera.up.y).toBeCloseTo(-1);
    }
    expect(camera.position.distanceTo(new THREE.Vector3(1, 2, 8))).toBeCloseTo(0);
    expect(camera.up.y).toBeCloseTo(1);
  });

  it("ignores unrelated pointer moves and releases all owned input listeners during a drag", () => {
    const f = fixture();
    f.pointer(f.documentTarget, "pointermove", 0, 300, 200);
    expect(f.draw).not.toHaveBeenCalled();
    f.pointer(f.canvas, "pointerdown", 0, 300, 200);
    f.pointer(f.documentTarget, "pointermove", 0, 300, 160);
    expect(f.draw).toHaveBeenCalled();
    f.dispose();
    f.draw.mockClear();
    const position = f.camera.position.clone();
    f.pointer(f.documentTarget, "pointermove", 0, 300, 0);
    f.pointer(f.documentTarget, "pointerup", 0, 300, 0);
    f.canvas.dispatchEvent(Object.assign(new Event("wheel"), { deltaMode: 0, deltaY: 100 }));
    f.windowTarget.dispatchEvent(Object.assign(new Event("keydown"), { code: "KeyA" }));
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.camera.position.equals(position)).toBe(true);
  });

  it("cancellation retains the camera but clears deferred input and document drag listeners", () => {
    const f = fixture();
    f.controls.minDistance = 1;
    f.controls.maxDistance = 25;
    f.pointer(f.canvas, "pointerdown", 0, 300, 200);
    f.pointer(f.documentTarget, "pointermove", 0, 300, 160);
    f.pointer(f.canvas, "pointercancel", 0, 300, 160);
    const position = f.camera.position.clone();
    const up = f.camera.up.clone();
    expect(f.controls.minDistance).toBe(1);
    expect(f.controls.maxDistance).toBe(25);
    f.draw.mockClear();
    f.pointer(f.documentTarget, "pointermove", 0, 300, 0);
    expect(f.draw).not.toHaveBeenCalled();
    f.controls.update();
    expect(f.camera.position.distanceTo(position)).toBeCloseTo(0);
    expect(f.camera.up.distanceTo(up)).toBeCloseTo(0);
    f.pointer(f.canvas, "pointerdown", 1, 300, 200);
    f.pointer(f.documentTarget, "pointermove", 1, 350, 200);
    f.controls.update();
    expect(f.controls.target.length()).toBeGreaterThan(0);
    f.dispose();
  });
});
