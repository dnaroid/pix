import { invoke } from "@tauri-apps/api/core";
import { parse, type ParseError } from "jsonc-parser";

export function readLogPanelEnabled(source: string): boolean {
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  return errors.length === 0 && config?.desktop?.logPanelEnabled === true;
}

/** A global UI preference, independent of the selected project and ACP connection. */
export function createLogPanelPreference(onDisabled: () => void) {
  let enabled = $state(false);
  function mount(): () => void {
    let disposed = false;
    let generation = 0;
    async function reload(): Promise<void> {
      const ticket = ++generation;
      let next = false;
      try {
        const document = await invoke<{ content: string }>("read_user_config", { kind: "desktop" });
        next = readLogPanelEnabled(document.content);
      } catch { /* Fail closed when the preference cannot be read. */ }
      if (disposed || ticket !== generation) return;
      enabled = next;
      if (!next) onDisabled();
    }
    const refresh = (): void => { void reload(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pix-desktop-config-changed", refresh);
    return () => {
      disposed = true;
      generation++;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pix-desktop-config-changed", refresh);
    };
  }
  return { get enabled() { return enabled; }, mount };
}
