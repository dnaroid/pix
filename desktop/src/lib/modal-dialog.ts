/**
 * Open a native modal dialog and restore the invoking control when it unmounts.
 * Native <dialog> owns focus containment; callers only choose the initial target.
 */
export function activateModalDialog(
  dialog: HTMLDialogElement,
  initialFocus?: () => HTMLElement | null | undefined,
): () => void {
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;
  if (!dialog.open) dialog.showModal();
  const frame = requestAnimationFrame(() => initialFocus?.()?.focus({ preventScroll: true }));

  return () => {
    cancelAnimationFrame(frame);
    if (dialog.open) dialog.close();
    requestAnimationFrame(() => previousFocus?.focus({ preventScroll: true }));
  };
}

