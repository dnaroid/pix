import {
  sidebarIndicatorActionGroups,
  type SidebarIndicatorActionGroup,
  type SidebarIndicatorActionId,
} from "../lib/sidebar-indicator-actions";
import type { SidebarIndicatorReasonMap, SidebarIndicatorTab } from "../lib/sidebar-indicator-types";
import { createSidebarIndicatorMenuController } from "./sidebar-indicator-menu-controller.svelte";

interface Options {
  workspace: () => string;
  reasons: () => SidebarIndicatorReasonMap;
  enabled: () => Partial<Record<SidebarIndicatorActionId, boolean>>;
  beforeOpen: () => void;
  reveal: (tab: SidebarIndicatorTab) => void;
  handlers: Partial<Record<SidebarIndicatorActionId, () => void>>;
}

/** Owns popup context and activation guards; command owners remain in the sidebar. */
export function createWorkspaceSidebarIndicatorActions(options: Options) {
  let popupWorkspace = "";
  let popupCommands = "";
  function groupsFor(tab: SidebarIndicatorTab): readonly SidebarIndicatorActionGroup[] {
    return sidebarIndicatorActionGroups(options.reasons()[tab], options.enabled());
  }
  const menu = createSidebarIndicatorMenuController({ items: (tab) => groupsFor(tab).flatMap((group) => group.actions) });

  function groups(): readonly SidebarIndicatorActionGroup[] {
    const tab = menu.state.tab;
    return tab && popupWorkspace === options.workspace() ? groupsFor(tab) : [];
  }

  function open(event: MouseEvent, tab: SidebarIndicatorTab): void {
    options.beforeOpen();
    popupWorkspace = options.workspace();
    popupCommands = commandSignature(groupsFor(tab));
    menu.open(event, tab);
  }

  function commandSignature(groups: readonly SidebarIndicatorActionGroup[]): string {
    return JSON.stringify(groups.map((group) => [group.id, group.actions.map((action) => [action.id, action.disabled])]));
  }

  function reconcile(): void {
    // Removing/disabling a focused DOM item would otherwise strand keyboard focus.
    if (menu.state.tab && commandSignature(groups()) !== popupCommands) menu.close(true);
  }

  function run(id: SidebarIndicatorActionId): void {
    const tab = menu.state.tab;
    const action = groups().flatMap((group) => group.actions).find((action) => action.id === id);
    if (!tab || !action || action.disabled) return;
    menu.close(true);
    const handler = options.handlers[id];
    if (handler) handler();
    else options.reveal(tab);
  }

  return { menu, groups, open, reconcile, run };
}
