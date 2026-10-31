import { createDiagnosticLogger } from "../lib/diagnostic-logging";
import { readGlbSource } from "../lib/glb-source";

let diagnostics: ReturnType<typeof createDiagnosticLogger> | undefined;
function reportContextLoss(): void {
  diagnostics ??= createDiagnosticLogger(() => ({ workspace: "" }));
  // Native logging accepts only allow-listed events; this one is the warn-level
  // media channel. No path: the record only needs to show that eviction happened.
  diagnostics.report("GLB preview WebGL context lost", "media:playback-unavailable");
}

/** Shared DOM owner for Preview and lazily hydrated Markdown. No render loop. */
export function mountGlbViewer(host: HTMLElement, source: string): () => void {
  let abort = new AbortController();
  host.classList.add("glb-viewer");
  const viewport = document.createElement("span");
  viewport.className = "glb-viewport";
  const status = document.createElement("span");
  status.className = "glb-status";
  status.setAttribute("role", "status");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "glb-reset";
  let scene: Awaited<ReturnType<typeof import("../lib/glb-scene").createGlbScene>>;
  let contextLost = false;
  const onReset = () => {
    // After a context loss the same control reloads the viewer.
    if (contextLost) load();
    else scene?.reset();
  };
  reset.addEventListener("click", onReset);

  function handleContextLost(owner: AbortController): void {
    if (owner !== abort || owner.signal.aborted) return;
    reportContextLoss();
    // Release the whole scene now; a lost context cannot draw and would keep
    // GPU-side bookkeeping alive until the message unmounts.
    owner.abort();
    scene?.dispose();
    scene = undefined;
    contextLost = true;
    status.textContent = "3D preview paused: the graphics context was released.";
    host.replaceChildren(viewport, status, reset);
    reset.textContent = "Reload 3D preview";
    reset.disabled = false;
  }

  function load(): void {
    abort.abort();
    scene?.dispose();
    scene = undefined;
    const owner = new AbortController();
    abort = owner;
    contextLost = false;
    status.textContent = "Loading 3D model…";
    reset.textContent = "Reset camera";
    reset.disabled = true;
    host.replaceChildren(viewport, status, reset);
    void (async () => {
      try {
        const bytes = await readGlbSource(source, owner.signal);
        if (owner.signal.aborted) return;
        const { createGlbScene } = await import("../lib/glb-scene");
        if (owner.signal.aborted) return;
        const created = await createGlbScene(viewport, bytes, owner.signal, {
          onContextLost: () => handleContextLost(owner),
        });
        if (owner.signal.aborted) { created?.dispose(); return; }
        scene = created;
        status.remove();
        reset.disabled = false;
      } catch (error) {
        if (owner.signal.aborted) return;
        status.textContent = `Cannot preview GLB: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  }

  load();
  return () => {
    abort.abort();
    reset.removeEventListener("click", onReset);
    scene?.dispose();
    scene = undefined;
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

/** Hysteresis so scrolling back and forth across the margin does not churn contexts. */
export const GLB_OFFSCREEN_RELEASE_MS = 1500;

/**
 * Viewport-scoped viewer for transcripts, which can contain many models.
 * WebKit caps active WebGL contexts (~16) and silently evicts the oldest, so a
 * viewer holds a renderer only while near the viewport: it is released shortly
 * after leaving and remounted (reloading the model and fitting the camera) on
 * re-entry. Without IntersectionObserver it behaves like mountGlbViewer.
 */
export function mountViewportGlbViewer(host: HTMLElement, source: string): () => void {
  if (typeof IntersectionObserver === "undefined") return mountGlbViewer(host, source);
  let dispose: (() => void) | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const cancelRelease = () => {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    releaseTimer = undefined;
  };
  const observer = new IntersectionObserver((entries) => {
    if (destroyed) return;
    const entry = entries[entries.length - 1];
    if (!entry) return;
    if (entry.isIntersecting) {
      cancelRelease();
      dispose ??= mountGlbViewer(host, source);
      return;
    }
    if (!dispose || releaseTimer !== undefined) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      if (destroyed) return;
      dispose?.();
      dispose = undefined;
    }, GLB_OFFSCREEN_RELEASE_MS);
  }, { rootMargin: "320px 0px" });
  observer.observe(host);
  return () => {
    destroyed = true;
    cancelRelease();
    observer.disconnect();
    dispose?.();
    dispose = undefined;
  };
}
