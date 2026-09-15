import { isTauri } from "@tauri-apps/api/core";
import { contextElement, desktopContextTarget, focusContextTarget, type DesktopContextTarget } from "./desktop-context-target";
import { createNativeContextMenuFactory, type ContextMenuPosition, type NativeContextMenu } from "./native-context-menu";

interface ContextMenuOptions {
  reportError: (error: unknown) => void;
  createMenu?: (context: DesktopContextTarget, isActive: () => boolean) => Promise<NativeContextMenu>;
}

/** Installed once per App mount, including secondary project windows. */
export function installDesktopContextMenu({ reportError, createMenu }: ContextMenuOptions): () => void {
  // A plain Vite browser preview is still a browser, not a privileged desktop host.
  if (!createMenu && !isTauri()) return () => {};
  const create = createMenu ?? createNativeContextMenuFactory(reportError);
  let generation = 0;
  let disposed = false;
  let active: { menu: NativeContextMenu; valid: boolean } | null = null;
  const capture = { capture: true };
  const released = new WeakSet<NativeContextMenu>();

  async function close(menu: NativeContextMenu): Promise<void> {
    // A popup rejection can arrive after replacement/disposal has released it.
    if (released.has(menu)) return;
    released.add(menu);
    try {
      await menu.close();
    } catch (error) {
      if (!disposed) reportError(error);
    }
  }
  function invalidatePending(): void { generation++; }
  function suppressBrowserMenu(event: MouseEvent): void {
    // Capture guarantees suppression even when a component stops propagation.
    // Do not stop the event: component-owned menus still get their normal handler.
    event.preventDefault();
    invalidatePending();
    if (active) active.valid = false;
  }

  async function show(context: DesktopContextTarget, position: ContextMenuPosition): Promise<void> {
    focusContextTarget(context);
    const request = ++generation;
    const previous = active;
    active = null;
    if (previous) { previous.valid = false; await close(previous.menu); }
    if (disposed || request !== generation) return;

    let owned: { menu: NativeContextMenu; valid: boolean } | null = null;
    try {
      const menu = await create(context, () => !disposed && Boolean(owned?.valid));
      owned = { menu, valid: false };
      if (disposed || request !== generation || !context.element.isConnected) {
        await close(menu);
        return;
      }
      owned.valid = true;
      active = owned;
      await menu.popup(position);
      // On GTK popup resolves before dismissal. Retain ownership until the next
      // popup/dispose rather than destroying a still-visible native menu here.
    } catch (error) {
      if (owned) {
        owned.valid = false;
        if (active === owned) active = null;
        await close(owned.menu);
      }
      if (!disposed && request === generation) reportError(error);
    }
  }

  function route(event: MouseEvent): void {
    const context = desktopContextTarget(event.target);
    if (!context) return; // Empty chrome has no invented or developer commands.
    const rect = context.element.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    void show(context, keyboard ? { x: rect.left + 8, y: rect.bottom } : { x: event.clientX, y: event.clientY });
  }

  function handleKeydown(event: KeyboardEvent): void {
    invalidatePending();
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)) return;
    const target = contextElement(document.activeElement);
    if (!target) return;
    event.preventDefault();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  }

  window.addEventListener("contextmenu", suppressBrowserMenu, capture);
  window.addEventListener("contextmenu", route);
  window.addEventListener("keydown", handleKeydown);
  // A delayed IPC menu must never appear over a different interaction/surface.
  const cancelEvents = ["pointerdown", "input", "focusin", "blur", "resize", "scroll"] as const;
  for (const name of cancelEvents) window.addEventListener(name, invalidatePending, capture);

  return () => {
    disposed = true;
    invalidatePending();
    window.removeEventListener("contextmenu", suppressBrowserMenu, capture);
    window.removeEventListener("contextmenu", route);
    window.removeEventListener("keydown", handleKeydown);
    for (const name of cancelEvents) window.removeEventListener(name, invalidatePending, capture);
    if (active) {
      active.valid = false;
      void close(active.menu);
      active = null;
    }
  };
}
