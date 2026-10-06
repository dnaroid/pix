import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

function disposeModel(gltf: GLTF): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const scene of gltf.scenes)
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) {
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]) {
          materials.add(material);
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture) textures.add(value);
        }
      }
      if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
    });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    const image = texture.source.data;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
      image.close();
    texture.dispose();
  }
}

export async function createGlbScene(
  host: HTMLElement,
  bytes: ArrayBuffer,
  signal: AbortSignal,
) {
  if (signal.aborted) return undefined;
  const manager = new THREE.LoadingManager();
  const objectUrls = new Set<string>();
  let parsingFinished = false;
  manager.setURLModifier((url) => {
    if (!/^(?:blob:|data:)/iu.test(url))
      throw new Error("External GLB resources are disabled.");
    if (parsingFinished || signal.aborted) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      throw new DOMException("Aborted", "AbortError");
    }
    if (url.startsWith("blob:")) objectUrls.add(url);
    return url;
  });
  // Three can abort resource reads, but not synchronous parser work. Dispose
  // any late completion instead of attaching a scene to its obsolete owner.
  const abortReads = () => manager.abort();
  signal.addEventListener("abort", abortReads, { once: true });
  let gltf: GLTF;
  try {
    gltf = await new GLTFLoader(manager).parseAsync(bytes, "");
  } catch (error) {
    manager.abort();
    throw error;
  } finally {
    parsingFinished = true;
    signal.removeEventListener("abort", abortReads);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }
  if (signal.aborted) {
    disposeModel(gltf);
    return undefined;
  }
  let disposed = false;
  const cleanups: (() => void)[] = [() => disposeModel(gltf)];
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.warn("GLB cleanup failed", error);
      }
    }
    cleanups.length = 0;
  }
  try {
    if (!gltf.scene) throw new Error("GLB has no default scene to preview.");
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    cleanups.push(() => {
      renderer.dispose();
      renderer.forceContextLoss();
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    const canvas = renderer.domElement;
    cleanups.push(() => canvas.remove());
    canvas.style.cssText =
      "display:block;width:100%;height:100%;touch-action:none";
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "3D model. Drag to rotate, scroll to zoom, arrow keys to rotate, plus/minus to zoom.",
    );
    host.append(canvas);
    const scene = new THREE.Scene();
    scene.add(gltf.scene);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, 5, 4);
    scene.add(light);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    cleanups.push(() => controls.dispose());
    controls.enablePan = false;
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.isEmpty()
      ? new THREE.Vector3()
      : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty()
      ? 1
      : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    let pendingFrame: number | undefined;
    cleanups.push(() => {
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      pendingFrame = undefined;
    });
    function draw() {
      if (disposed || pendingFrame !== undefined) return;
      // Paint after layout/visibility changes settle, not synchronously while
      // the workbench is hiding or restoring retained viewer canvases.
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        if (!disposed && host.isConnected && host.clientWidth > 0 && host.clientHeight > 0)
          renderer.render(scene, camera);
      });
    }
    function reset() {
      const halfFov = Math.atan(
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
          Math.min(camera.aspect, 1),
      );
      const distance = (radius / Math.sin(halfFov)) * 1.15;
      controls.target.copy(center);
      camera.position
        .copy(center)
        .add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
      camera.near = radius / 100;
      camera.far = Math.max(distance * 10, radius * 100);
      controls.minDistance = radius * 1.05;
      controls.maxDistance = distance * 5;
      camera.updateProjectionMatrix();
      controls.update();
      draw();
    }
    function resize() {
      if (disposed) return;
      const width = host.clientWidth,
        height = host.clientHeight;
      // A hidden tab is not a new viewport; retain its buffer and camera aspect.
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    }
    function keydown(event: KeyboardEvent) {
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          controls.rotateLeft(event.key === "ArrowLeft" ? 0.15 : -0.15);
        else controls.rotateUp(event.key === "ArrowUp" ? 0.15 : -0.15);
        controls.update();
      } else if (["+", "=", "-"].includes(event.key)) {
        event.preventDefault();
        const offset = camera.position
          .clone()
          .sub(controls.target)
          .multiplyScalar(event.key === "-" ? 1.15 : 1 / 1.15);
        offset.clampLength(controls.minDistance, controls.maxDistance);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        draw();
      }
    }
    canvas.addEventListener("keydown", keydown);
    cleanups.push(() => canvas.removeEventListener("keydown", keydown));
    controls.addEventListener("change", draw);
    cleanups.push(() => controls.removeEventListener("change", draw));
    const observer = new ResizeObserver(resize);
    cleanups.push(() => observer.disconnect());
    observer.observe(host);
    if (typeof IntersectionObserver !== "undefined") {
      const visibilityObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) resize();
      });
      cleanups.push(() => visibilityObserver.disconnect());
      visibilityObserver.observe(host);
    }
    resize();
    reset();
    return { reset, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
