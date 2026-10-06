/** Use the roomier side of the invoker: above status bars, below pane headers. */
export function modelPickerPopoverPosition(
  anchor: Pick<DOMRect, "left" | "top"> & Partial<Pick<DOMRect, "bottom">>,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top?: number; bottom: number; width: number; maxHeight: number } {
  const width = Math.min(520, Math.max(0, viewportWidth - 16));
  const above = Math.max(0, anchor.top - 8);
  const anchorBottom = anchor.bottom ?? anchor.top;
  const below = Math.max(0, viewportHeight - anchorBottom - 8);
  const useBelow = below > above;
  return {
    left: Math.max(8, Math.min(anchor.left, viewportWidth - width - 8)),
    ...(useBelow ? { top: anchorBottom } : {}),
    bottom: Math.max(0, useBelow ? 8 : viewportHeight - anchor.top),
    width,
    maxHeight: Math.max(0, Math.min(viewportHeight - 70, useBelow ? below : above)),
  };
}

/** Non-modal ownership: no backdrop, focus trap, or restoration on outside dismissal. */
export function activateModelPickerPopover(
  panel: HTMLDialogElement,
  search: HTMLInputElement | null,
  onClose: () => void,
  onPosition: (position: ReturnType<typeof modelPickerPopoverPosition>) => void,
  invoker?: HTMLButtonElement,
): { close: () => void; dispose: () => void } {
  const trigger = invoker ?? document.querySelector<HTMLButtonElement>("[data-model-thinking-trigger]");
  let disposed = false;
  let pointerInPanel = false;

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
    pointerInPanel = event.target instanceof Node && panel.contains(event.target);
    if (!inside(event.target)) close(false);
  }

  function focusButton(event: PointerEvent): void {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button");
    // WKWebView does not always focus clicked buttons. Keep focus in the popup
    // before its deferred focusout check, or Apply can be removed before click.
    if (button && panel.contains(button) && !button.disabled) button.focus({ preventScroll: true });
  }

  function leave(event: FocusEvent): void {
    if (inside(event.relatedTarget)) return;
    // Removing a focused dialog dispatches focusout synchronously during Svelte
    // teardown. Wait until removal/ownership disposal finishes before mutating UI.
    queueMicrotask(() => {
      if (disposed || inside(document.activeElement)) return;
      // WebKit may blur search to the document during a button press before
      // dispatching click. That transient gap is not an outside dismissal.
      if (pointerInPanel && document.activeElement === document.body) return;
      close(false);
    });
  }

  function escape(event: KeyboardEvent): void {
    pointerInPanel = false;
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", escape, true);
  window.addEventListener("resize", position);
  panel.addEventListener("focusout", leave);
  panel.addEventListener("pointerdown", focusButton);
  position();
  search?.focus();

  return {
    close: () => close(),
    dispose: () => {
      disposed = true;
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      panel.removeEventListener("focusout", leave);
      panel.removeEventListener("pointerdown", focusButton);
    },
  };
}
