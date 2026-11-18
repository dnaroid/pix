import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";

/** The supervisor tab is pinned and long-lived; closing it needs consent. */
export async function confirmSupervisorTabClose(running: boolean): Promise<boolean> {
  const message = "The project supervisor stops watching this project until you open it again."
    + " Its conversation is kept; Open Project Supervisor reopens it."
    + (running ? "\n\nThe active supervisor run will be stopped." : "");
  if (!isTauri()) return window.confirm(`${message}\nClose it?`) === true;
  return confirm(message, {
    title: "Close the project supervisor tab?",
    kind: "warning",
    okLabel: "Close tab",
    cancelLabel: "Cancel",
  });
}

export async function confirmRunningTabClose(title: string): Promise<boolean> {
  const message = `“${title}” is still running.\n\nClosing this tab will stop the active run.`;
  if (!isTauri()) return window.confirm(`${message}\nClose it?`) === true;
  return confirm(message, {
    title: "Close running conversation?",
    kind: "warning",
    okLabel: "Close tab",
    cancelLabel: "Cancel",
  });
}
