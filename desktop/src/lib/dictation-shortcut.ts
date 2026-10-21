/** Shared with the macOS HID event tap; always targeted to one WebView. */
export const DICTATION_SHORTCUT_EVENT = "pix:dictation-shortcut";

interface DictationShortcutOptions {
  readonly listen: (handler: () => void) => Promise<() => void>;
  readonly setNativeEnabled: (enabled: boolean) => Promise<void>;
  readonly canToggle: () => boolean;
  readonly toggle: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/**
 * True only for a visible modal dialog. Always-mounted non-modal popovers
 * (e.g. hidden status-bar `role="dialog"` panels) must not block the shortcut.
 */
export function hasBlockingModal(root: ParentNode = document): boolean {
  const candidates: Element[] = [...root.querySelectorAll('[aria-modal="true"]')];
  try {
    candidates.push(...root.querySelectorAll("dialog:modal"));
  } catch {
    // Engines without :modal: fall back to open <dialog> elements.
    candidates.push(...root.querySelectorAll("dialog[open]"));
  }
  return candidates.some((element) => !element.closest("[hidden]"));
}

/** Mount synchronously so a late native listener registration can be disposed. */
export function attachDictationShortcut(options: DictationShortcutOptions) {
  let disposed = false;
  let registered = false;
  let desiredEnabled = false;
  let requestedEnabled = false;
  let pending = Promise.resolve();
  let unlisten: (() => void) | undefined;

  function syncEnabled(): void {
    const enabled = !disposed && registered && desiredEnabled;
    if (enabled === requestedEnabled) return;
    requestedEnabled = enabled;
    // A delayed enable must never overtake disable on unmount.
    pending = pending.then(async () => {
      if (enabled && disposed) return;
      await options.setNativeEnabled(enabled);
    }).catch((error) => {
      if (!disposed) options.onError(error);
    });
  }
  void options.listen(() => {
    if (disposed || !options.canToggle()) return;
    void options.toggle().catch((error) => {
      if (!disposed) options.onError(error);
    });
  }).then((release) => {
    if (disposed) release();
    else {
      unlisten = release;
      registered = true;
      syncEnabled();
    }
  }).catch((error) => {
    if (!disposed) options.onError(error);
  });
  return {
    setEnabled(enabled: boolean) {
      desiredEnabled = enabled;
      syncEnabled();
    },
    dispose() {
      disposed = true;
      syncEnabled();
      unlisten?.();
      unlisten = undefined;
    },
  };
}
