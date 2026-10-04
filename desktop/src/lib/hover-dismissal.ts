/** Grace period for diagonal pointer travel from a small trigger to its popup. */
export const HOVER_DISMISS_DELAY_MS = 200;

export function createHoverDismissal(): {
  schedule: (isRetained: () => boolean, dismiss: () => void) => void;
  cancel: () => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(isRetained: () => boolean, dismiss: () => void): void {
    cancel();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && !isRetained()) dismiss();
    }, HOVER_DISMISS_DELAY_MS);
  }

  function dispose(): void {
    disposed = true;
    cancel();
  }

  return { schedule, cancel, dispose };
}
