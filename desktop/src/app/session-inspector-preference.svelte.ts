import { windowLayoutKey } from "../lib/window-layout-storage";

export function createSessionInspectorPreference() {
  const storageKey = windowLayoutKey("sessionInspectorOpen");
  let open = $state(false);

  function restore(): void {
    try {
      open = localStorage.getItem(storageKey) === "true";
    } catch {
      open = false;
    }
  }

  function setOpen(next: boolean): void {
    open = next;
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Persistence is a convenience; keep the in-memory preference.
    }
  }

  return {
    get open() { return open; },
    restore,
    setOpen,
  };
}
