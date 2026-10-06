import { readGlbSource } from "../lib/glb-source";

/** Shared DOM owner for Preview and lazily hydrated Markdown. No render loop. */
export function mountGlbViewer(host: HTMLElement, source: string): () => void {
  const abort = new AbortController();
  host.classList.add("glb-viewer");
  const viewport = document.createElement("span");
  viewport.className = "glb-viewport";
  const status = document.createElement("span");
  status.className = "glb-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading 3D model…";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "glb-reset";
  reset.textContent = "Reset camera";
  reset.disabled = true;
  host.replaceChildren(viewport, status, reset);
  let scene: Awaited<ReturnType<typeof import("../lib/glb-scene").createGlbScene>>;
  const onReset = () => scene?.reset();
  reset.addEventListener("click", onReset);
  void (async () => {
    try {
      const bytes = await readGlbSource(source, abort.signal);
      if (abort.signal.aborted) return;
      const { createGlbScene } = await import("../lib/glb-scene");
      if (abort.signal.aborted) return;
      scene = await createGlbScene(viewport, bytes, abort.signal);
      if (abort.signal.aborted) { scene?.dispose(); return; }
      status.remove();
      reset.disabled = false;
    } catch (error) {
      if (abort.signal.aborted) return;
      status.textContent = `Cannot preview GLB: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  return () => {
    abort.abort();
    reset.removeEventListener("click", onReset);
    scene?.dispose();
    host.replaceChildren();
  };
}

export function glbViewer(host: HTMLElement, source: string) {
  let dispose = mountGlbViewer(host, source);
  return {
    update(next: string) {
      if (next === source) return;
      source = next;
      dispose();
      dispose = mountGlbViewer(host, source);
    },
    destroy() { dispose(); },
  };
}
