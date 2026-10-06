import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";

// Unlike spherical OrbitControls, TrackballControls rotates the camera's up
// vector with its position, so crossing either pole has no clamp or snap.
export function createGlbControls(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  requestDraw: () => void,
) {
  function createControls() {
    const controls = new TrackballControls(camera, canvas);
    controls.staticMoving = true;
    controls.keys = ["", "", ""]; // No global A/S/D mode overrides.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.addEventListener("start", requestDraw);
    controls.addEventListener("change", requestDraw);
    controls.addEventListener("end", requestDraw);
    return controls;
  }
  let controls = createControls();
  function releaseControls() {
    controls.removeEventListener("start", requestDraw);
    controls.removeEventListener("change", requestDraw);
    controls.removeEventListener("end", requestDraw);
    controls.dispose();
  }
  const pointers = new Set<number>();
  function releasePointers() {
    for (const id of pointers) {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    }
    pointers.clear();
  }
  const down = (event: PointerEvent) => pointers.add(event.pointerId);
  const move = (event: PointerEvent) => {
    if (pointers.has(event.pointerId)) requestDraw();
  };
  const up = (event: PointerEvent) => {
    if (pointers.delete(event.pointerId)) requestDraw();
  };
  const cancel = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    // Trackball's pointercancel only removes the ID: it leaves document move
    // listeners and touch state alive. Recreate the input owner, not the view.
    controls.update();
    const target = controls.target.clone();
    const { minDistance, maxDistance } = controls;
    releaseControls();
    releasePointers();
    controls = createControls();
    controls.target.copy(target);
    controls.minDistance = minDistance;
    controls.maxDistance = maxDistance;
    controls.update();
    requestDraw();
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointercancel", cancel);
  canvas.ownerDocument.addEventListener("pointermove", move);
  canvas.ownerDocument.addEventListener("pointerup", up);
  return {
    get controls() { return controls; },
    dispose() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.ownerDocument.removeEventListener("pointermove", move);
      canvas.ownerDocument.removeEventListener("pointerup", up);
      releaseControls();
      releasePointers();
    },
  };
}

export function rotateGlbCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  horizontal: number,
  vertical: number,
) {
  const offset = camera.position.clone().sub(target);
  const right = new THREE.Vector3().crossVectors(camera.up, offset).normalize();
  const rotation = new THREE.Quaternion()
    .setFromAxisAngle(camera.up.clone().normalize(), -horizontal)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, -vertical));
  camera.position.copy(target).add(offset.applyQuaternion(rotation));
  camera.up.applyQuaternion(rotation).normalize();
  camera.lookAt(target);
}
