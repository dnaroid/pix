/** Keep the non-modal picker above its status-bar invoker and inside the viewport. */
export function modelPickerPopoverPosition(
  anchor: Pick<DOMRect, "left" | "top">,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; bottom: number; width: number; maxHeight: number } {
  const width = Math.min(520, Math.max(0, viewportWidth - 16));
  return {
    left: Math.max(8, Math.min(anchor.left, viewportWidth - width - 8)),
    bottom: Math.max(0, viewportHeight - anchor.top),
    width,
    maxHeight: Math.max(0, Math.min(600, anchor.top - 8)),
  };
}

/** Non-modal ownership: no backdrop, focus trap, or restoration on outside dismissal. */
export function activateModelPickerPopover(
  panel: HTMLDialogElement,
  search: HTMLInputElement | null,
  onClose: () => void,
  onPosition: (position: ReturnType<typeof modelPickerPopoverPosition>) => void,
): { close: () => void; dispose: () => void } {
  const trigger = document.querySelector<HTMLButtonElement>("[data-model-thinking-trigger]");
  let disposed = false;

  function position(): void {
    if (disposed) return;
    onPosition(modelPickerPopoverPosition(
      trigger?.getBoundingClientRect() ?? { left: 8, top: window.innerHeight - 32 },
      window.innerWidth, window.innerHeight,
    ));
  }

  function close(restore = true): void {
    if (disposed) return;
    if (restore && panel.contains(document.activeElement)) trigger?.focus();
    onClose();
  }

  function inside(target: EventTarget | null): boolean {
    return target instanceof Node && (panel.contains(target) || !!trigger?.contains(target));
  }

  function outside(event: PointerEvent): void {
    if (!inside(event.target)) close(false);
  }

  function leave(event: FocusEvent): void {
    if (!inside(event.relatedTarget)) close(false);
  }

  function escape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  window.addEventListener("pointerdown", outside);
  window.addEventListener("keydown", escape);
  window.addEventListener("resize", position);
  panel.addEventListener("focusout", leave);
  position();
  search?.focus();

  return {
    close: () => close(),
    dispose: () => {
      disposed = true;
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position);
      panel.removeEventListener("focusout", leave);
    },
  };
}
