import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Layout belongs to a stable native window, never to a workspace or shared origin. */
export function windowLayoutKey(preference: string): string {
  const label = isTauri() ? getCurrentWindow().label : "browser-preview";
  return `pix.desktop.windowLayout.${encodeURIComponent(label)}.${preference}`;
}
