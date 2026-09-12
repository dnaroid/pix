const STORAGE_KEY = "pix.desktop.sessionInspectorOpen";

export function createSessionInspectorPreference() {
  let open = $state(false);

  function restore(): void {
    try {
      open = localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      open = false;
    }
  }

  function setOpen(next: boolean): void {
    open = next;
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
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
