import { getCurrentWindow } from "@tauri-apps/api/window";

const DRAG_THRESHOLD = 4;

export function titlebarDrag(node: HTMLElement): { destroy: () => void } {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let suppressClick = false;

  function stopTracking(): void {
    tracking = false;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;

    stopTracking();
    startX = event.clientX;
    startY = event.clientY;
    tracking = true;
    suppressClick = false;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!tracking || Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;

    tracking = false;
    suppressClick = true;
    window.removeEventListener("pointermove", handlePointerMove);
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(() => {
      suppressClick = false;
    });
  }

  function handlePointerUp(): void {
    stopTracking();
    window.setTimeout(() => {
      suppressClick = false;
    });
  }

  function handleClick(event: MouseEvent): void {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  node.addEventListener("pointerdown", handlePointerDown);
  node.addEventListener("click", handleClick, { capture: true });

  return {
    destroy(): void {
      stopTracking();
      node.removeEventListener("pointerdown", handlePointerDown);
      node.removeEventListener("click", handleClick, { capture: true });
    },
  };
}
