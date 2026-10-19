import type { WorkbenchTab, WorkbenchTabId } from "./workbench-tabs";

/** Keep explicit visual order; newly opened tabs retain their canonical neighbor. */
export function orderedWorkbenchTabs(tabs: readonly WorkbenchTab[], order: readonly WorkbenchTabId[]): WorkbenchTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ids = [...new Set(order)].filter((id) => byId.has(id));
  for (let index = 0; index < tabs.length; index++) {
    const id = tabs[index]!.id;
    if (ids.includes(id)) continue;
    const previous = tabs[index - 1]?.id;
    ids.splice(previous ? ids.indexOf(previous) + 1 : 0, 0, id);
  }
  return ids.map((id) => byId.get(id)!);
}

export function moveWorkbenchTab(tabs: readonly WorkbenchTab[], id: WorkbenchTabId, beforeId: WorkbenchTabId | null): WorkbenchTabId[] {
  const ids = tabs.map((tab) => tab.id);
  if (!ids.includes(id) || id === beforeId || (beforeId !== null && !ids.includes(beforeId))) return ids;
  const remaining = ids.filter((candidate) => candidate !== id);
  remaining.splice(beforeId === null ? remaining.length : remaining.indexOf(beforeId), 0, id);
  return remaining;
}
