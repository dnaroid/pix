import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";

export async function confirmRunningTabClose(title: string): Promise<boolean> {
  const message = `“${title}” is still running.\n\nClosing this tab will stop the active run.`;
  if (!isTauri()) return window.confirm(`${message}\nClose it?`);
  return confirm(message, {
    title: "Close running conversation?",
    kind: "warning",
    okLabel: "Close tab",
    cancelLabel: "Cancel",
  });
}
