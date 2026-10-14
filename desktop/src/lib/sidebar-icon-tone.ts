import type { SidebarIndicator } from "./sidebar-indicators";

export function sidebarIconTone(indicator?: SidebarIndicator): string {
  if (indicator?.tone === "error") return "text-tool-error";
  if (indicator?.tone === "warning") return "text-tool-warning";
  return "";
}
