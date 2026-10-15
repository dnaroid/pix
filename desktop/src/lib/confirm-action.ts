import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { createDiagnosticLogger } from "./diagnostic-logging";

type ConfirmationOptions = {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
};

const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));

/**
 * Never use window.confirm inside Tauri: the dialog plugin overrides it with
 * an async legacy bridge that calls a command the native plugin no longer
 * registers. A Promise is truthy, so synchronous checks silently allow
 * destructive actions. The supported plugin API invokes dialog.message.
 */
export async function confirmDesktopAction(message: string, options: ConfirmationOptions = {}): Promise<boolean> {
  if (!isTauri()) {
    try { return window.confirm(message) === true; }
    catch (error) { diagnostics.report(error); return false; }
  }
  try {
    return await confirm(message, { kind: "warning", cancelLabel: "Cancel", ...options }) === true;
  } catch (error) {
    diagnostics.report(error);
    return false;
  }
}
