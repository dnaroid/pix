import {
  sidebarIndicatorActionGroups,
  type SidebarIndicatorActionGroup,
  type SidebarIndicatorActionId,
} from "../lib/sidebar-indicator-actions";
import type { SidebarIndicatorReasonMap, SidebarIndicatorTab } from "../lib/sidebar-indicator-types";
import { createSidebarIndicatorMenuController } from "./sidebar-indicator-menu-controller.svelte";
import { fuzzySearch } from "../lib/fuzzy";

interface Options {
  bounds?: () => { top: number; bottom: number } | undefined;
  workspace: () => string;
  reasons: () => SidebarIndicatorReasonMap;
  enabled: () => Partial<Record<SidebarIndicatorActionId, boolean>>;
  gitRemotes?: () => readonly string[];
  extraGroups?: (tab: SidebarIndicatorTab) => readonly SidebarIndicatorActionGroup[];
  runExtra?: (id: SidebarIndicatorActionId) => boolean;
  beforeOpen: () => void;
  reveal: (tab: SidebarIndicatorTab) => void;
  handlers: Partial<Record<SidebarIndicatorActionId, () => void>>;
}

/** Owns popup context and activation guards; command owners remain in the sidebar. */
export function createWorkspaceSidebarIndicatorActions(options: Options) {
  let popupWorkspace = "";
  let popupCommands = "";
  function groupsFor(tab: SidebarIndicatorTab): readonly SidebarIndicatorActionGroup[] {
    const reasons = options.reasons()[tab]?.filter((reason) => reason.id !== "scripts.running");
    return [...(options.extraGroups?.(tab) ?? []), ...sidebarIndicatorActionGroups(reasons, options.enabled(), options.gitRemotes?.())];
  }
  function filteredGroups(tab: SidebarIndicatorTab, query: string): readonly SidebarIndicatorActionGroup[] {
    const groups = groupsFor(tab);
    if (tab !== "scripts" || !query.trim()) return groups;
    return groups.map((group) => group.id !== "scripts.commands" ? group : {
      ...group,
      actions: fuzzySearch(group.actions.map((action) => ({ value: action, label: action.commandName ?? action.label })), query)
        .map((match) => match.value),
    });
  }
  const menu = createSidebarIndicatorMenuController({ bounds: options.bounds, items: (tab, query) => filteredGroups(tab, query).flatMap((group) => group.actions) });

  function groups(): readonly SidebarIndicatorActionGroup[] {
    const tab = menu.state.tab;
    return tab && popupWorkspace === options.workspace() ? filteredGroups(tab, menu.state.filter) : [];
  }

  function open(event: MouseEvent, tab: SidebarIndicatorTab): void {
    options.beforeOpen();
    popupWorkspace = options.workspace();
    popupCommands = commandSignature(groupsFor(tab));
    menu.open(event, tab);
  }

  function commandSignature(groups: readonly SidebarIndicatorActionGroup[]): string {
    return JSON.stringify(groups.map((group) => [group.id, group.actions.map((action) => [action.id, action.label, action.disabled])]));
  }

  function reconcile(): void {
    // Removing/disabling a focused DOM item would otherwise strand keyboard focus.
    if (menu.state.tab && (popupWorkspace !== options.workspace() || commandSignature(groupsFor(menu.state.tab)) !== popupCommands)) menu.close(true);
  }

  function run(id: SidebarIndicatorActionId): void {
    const tab = menu.state.tab;
    const action = groups().flatMap((group) => group.actions).find((action) => action.id === id);
    if (!tab || !action || action.disabled) return;
    menu.close(true);
    if (options.runExtra?.(id)) return;
    const handler = options.handlers[id];
    if (handler) handler();
    else options.reveal(tab);
  }

  return { menu, groups, open, reconcile, run };
}
