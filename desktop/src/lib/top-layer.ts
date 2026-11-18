/**
 * Keep a floating surface (the toast stack) above native modal dialogs.
 * `showModal()` puts a dialog in the browser top layer, above every z-index.
 * A manual popover is also in the top layer, ordered by insertion, so the
 * surface is re-shown after each modal opens (`activateModalDialog`).
 */
export const MODAL_OPENED_EVENT = "pix:modal-opened";

export function announceModalOpened(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MODAL_OPENED_EVENT));
}

export function keepAboveModals(element: HTMLElement, report: (error: unknown) => void): () => void {
  // Older WebViews without the Popover API keep the ordinary z-index stack.
  if (typeof element.showPopover !== "function") return () => {};
  const open = () => element.matches(":popover-open");
  const raise = () => {
    try {
      if (open()) element.hidePopover();
      element.showPopover();
    } catch (error) {
      report(error);
    }
  };
  raise();
  window.addEventListener(MODAL_OPENED_EVENT, raise);
  return () => {
    window.removeEventListener(MODAL_OPENED_EVENT, raise);
    try {
      if (open()) element.hidePopover();
    } catch (error) {
      report(error);
    }
  };
}
