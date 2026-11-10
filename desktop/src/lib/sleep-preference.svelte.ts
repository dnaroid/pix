import { invoke } from "@tauri-apps/api/core";
import { parse, type ParseError } from "jsonc-parser";
import { createDiagnosticLogger, createFailureStreakReporter } from "./diagnostic-logging";

export const DEFAULT_SLEEP_HOURS = 6;

export function readSleepHours(source: string): number {
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  const hours = config?.desktop?.sleepHours;
  return errors.length === 0 && typeof hours === "number" && Number.isFinite(hours) && hours >= 0.5 && hours <= 24
    ? hours : DEFAULT_SLEEP_HOURS;
}

/** Global preference: owned by the mounted calendar, not its ACP session. */
export function createSleepPreference() {
  let hours = $state(DEFAULT_SLEEP_HOURS);
  const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
  const failures = createFailureStreakReporter(error => diagnostics.warn("usage:sleep-preference", error));

  function mount(): () => void {
    let disposed = false;
    let generation = 0;
    async function reload(): Promise<void> {
      const ticket = ++generation;
      try {
        const document = await invoke<{ content: string }>("read_user_config", { kind: "desktop" });
        if (disposed || ticket !== generation) return;
        hours = readSleepHours(document.content);
        failures.success();
      } catch {
        if (disposed || ticket !== generation) return;
        // Do not log config content or IPC error text, which may contain secrets.
        failures.failure(new Error("Unable to read sleep duration; retaining last known value"));
      }
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
  return { get hours() { return hours; }, mount };
}
