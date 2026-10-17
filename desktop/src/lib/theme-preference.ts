import { setTheme } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { parse, type ParseError } from "jsonc-parser";

export type DesktopTheme = "system" | "light" | "dark";

export function readDesktopTheme(source: string): DesktopTheme {
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true }) as { desktop?: { theme?: unknown } } | undefined;
  const theme = errors.length === 0 ? config?.desktop?.theme : undefined;
  return theme === "light" || theme === "dark" ? theme : "system";
}

/**
 * Applies the global `desktop.theme` preference through the native app
 * appearance, so CSS `prefers-color-scheme` and matchMedia listeners
 * (terminal, markdown, sandboxes) follow it without a parallel theme system.
 */
export function startThemePreference(
  onError: (error: unknown) => void,
  deps: {
    read?: () => Promise<string>;
    apply?: (theme: DesktopTheme) => Promise<void>;
    target?: Window;
  } = {},
): () => void {
  const read = deps.read ?? (async () => (await invoke<{ content: string }>("read_user_config", { kind: "desktop" })).content);
  const apply = deps.apply ?? ((theme: DesktopTheme) => setTheme(theme === "system" ? null : theme));
  const target = deps.target ?? window;
  if (!deps.apply && !isTauri()) return () => {};
  let disposed = false;
  let generation = 0;
  let applied: DesktopTheme | undefined;
  async function reload(): Promise<void> {
    const ticket = ++generation;
    let next: DesktopTheme;
    try {
      next = readDesktopTheme(await read());
    } catch (error) {
      onError(error);
      return; // Keep the current appearance when the preference is unreadable.
    }
    if (disposed || ticket !== generation || next === applied) return;
    try {
      await apply(next);
      if (!disposed && ticket === generation) applied = next;
    } catch (error) {
      if (!disposed) onError(error);
    }
  }
  const refresh = (): void => { void reload(); };
  refresh();
  target.addEventListener("focus", refresh);
  target.addEventListener("pix-desktop-config-changed", refresh);
  return () => {
    disposed = true;
    generation++;
    target.removeEventListener("focus", refresh);
    target.removeEventListener("pix-desktop-config-changed", refresh);
  };
}
