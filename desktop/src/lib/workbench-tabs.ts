import type { SessionActivityTone } from "./session-activity";

export type WorkbenchTabId = `session:${string}` | "preview" | "git-diff";

interface WorkbenchTabBase {
  readonly id: WorkbenchTabId;
  readonly label: string;
  readonly title: string;
  readonly panelId: string;
  readonly closable: boolean;
  readonly disabled?: boolean;
}

export interface WorkbenchSessionTab extends WorkbenchTabBase {
  readonly kind: "session";
  readonly sessionId: string;
  readonly runtimeActive: boolean;
  readonly running: boolean;
  readonly draft: boolean;
  readonly fork: boolean;
  readonly activityTone: SessionActivityTone;
  readonly activityLabel: string;
  readonly pulsing: boolean;
}

export interface WorkbenchPreviewTab extends WorkbenchTabBase {
  readonly kind: "preview";
  readonly dirty: boolean;
}

export interface WorkbenchDiffTab extends WorkbenchTabBase {
  readonly kind: "diff";
  readonly busy: boolean;
}

export type WorkbenchTab = WorkbenchSessionTab | WorkbenchPreviewTab | WorkbenchDiffTab;

export interface WorkbenchAuxiliaryPlacement {
  readonly tab: WorkbenchPreviewTab | WorkbenchDiffTab;
  readonly insertAfterId?: WorkbenchTabId | null;
  readonly openedOrder: number;
}

export function workbenchSessionTabId(sessionId: string): WorkbenchTabId {
  return `session:${sessionId}`;
}

export function workbenchSessionId(tabId: WorkbenchTabId | null | undefined): string | null {
  if (!tabId?.startsWith("session:")) return null;
  return tabId.slice("session:".length);
}

/**
 * Merge workspace-only editor tabs into the canonical session order without
 * letting Preview/Diff participate in ACP/TUI session membership.
 *
 * Auxiliary tabs remember which visible workbench tab opened them. Processing
 * placements in creation order lets a Preview opened from Diff (or vice versa)
 * form the same adjacent chain a desktop editor would produce.
 */
export function buildWorkbenchTabs(
  sessionTabs: readonly WorkbenchSessionTab[],
  auxiliaryTabs: readonly WorkbenchAuxiliaryPlacement[],
): WorkbenchTab[] {
  const result: WorkbenchTab[] = [...sessionTabs];
  const placements = [...auxiliaryTabs].sort((left, right) => left.openedOrder - right.openedOrder);
  for (const placement of placements) {
    const existingIndex = result.findIndex((tab) => tab.id === placement.tab.id);
    if (existingIndex >= 0) result.splice(existingIndex, 1);
    const anchorIndex = placement.insertAfterId
      ? result.findIndex((tab) => tab.id === placement.insertAfterId)
      : -1;
    if (anchorIndex < 0) result.push(placement.tab);
    else result.splice(anchorIndex + 1, 0, placement.tab);
  }
  return result;
}

export function workbenchTabCloseFallback(
  tabs: readonly WorkbenchTab[],
  closingId: WorkbenchTabId,
): WorkbenchTabId | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0) return tabs[0]?.id ?? null;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

export function normalizeWorkbenchTab(
  activeId: WorkbenchTabId | null,
  tabs: readonly WorkbenchTab[],
  preferredId?: WorkbenchTabId | null,
): WorkbenchTabId | null {
  if (activeId && tabs.some((tab) => tab.id === activeId)) return activeId;
  if (preferredId && tabs.some((tab) => tab.id === preferredId)) return preferredId;
  return tabs[0]?.id ?? null;
}
