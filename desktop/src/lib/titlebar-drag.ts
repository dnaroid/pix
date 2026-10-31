import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDiagnosticLogger } from "./diagnostic-logging";

const DRAG_THRESHOLD = 4;
const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));

export function titlebarDrag(node: HTMLElement, region = false): { destroy: () => void } {
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;
  let tracking = false;
  let suppressClick = false;
  let generation = 0;
  let clickReset: ReturnType<typeof window.setTimeout> | undefined;

  function stopTracking(): void {
    tracking = false;
    pointerId = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
  }

  function reset(): void {
    generation++;
    stopTracking();
    window.clearTimeout(clickReset);
    clickReset = undefined;
    suppressClick = false;
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.isPrimary === false || (region && event.target !== node)) return;

    reset();
    startX = event.screenX;
    startY = event.screenY;
    pointerId = event.pointerId;
    tracking = true;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }

  function handleMouseDown(event: MouseEvent): void {
    if (!region || event.target !== node || event.button !== 0) return;
    // Keep Tauri's native macOS double-click handling, but never let its
    // mousedown-only drag path consume an activating click. AppKit may still
    // have a window-activation event (rather than a mouse event) at that point.
    if (event.detail === 2) {
      reset();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!tracking || event.pointerId !== pointerId) return;
    if ((event.buttons & 1) === 0) {
      reset();
      return;
    }
    if (Math.hypot(event.screenX - startX, event.screenY - startY) < DRAG_THRESHOLD) return;

    tracking = false;
    suppressClick = true;
    window.removeEventListener("pointermove", handlePointerMove);
    event.preventDefault();
    const owner = generation;
    void getCurrentWindow().startDragging().catch((error) => {
      diagnostics.warn("frontend:titlebar-drag", error);
      if (owner === generation) suppressClick = false;
    });
  }

  function handlePointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    stopTracking();
    clickReset = window.setTimeout(() => {
      clickReset = undefined;
      suppressClick = false;
    });
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (event.pointerId === pointerId) reset();
  }

  function handleClick(event: MouseEvent): void {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  node.addEventListener("pointerdown", handlePointerDown);
  node.addEventListener("mousedown", handleMouseDown);
  node.addEventListener("click", handleClick, { capture: true });
  window.addEventListener("blur", reset);

  return {
    destroy(): void {
      reset();
      node.removeEventListener("pointerdown", handlePointerDown);
      node.removeEventListener("mousedown", handleMouseDown);
      node.removeEventListener("click", handleClick, { capture: true });
      window.removeEventListener("blur", reset);
    },
  };
}

/** Direct-hit empty regions retain Tauri's double-click-to-zoom behavior. */
export function titlebarRegionDrag(node: HTMLElement): { destroy: () => void } {
  return titlebarDrag(node, true);
}
