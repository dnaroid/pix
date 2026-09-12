import {
  ACTIVE_SESSIONS_STORAGE_KEY,
  mergeRestoredSessionTabs,
  replaceSessionTab,
  serializeActiveSessionIds,
} from "../lib/session-tabs";

export type SessionSelectorMode = "open" | "delete";

export function createSessionTabsState() {
  let restoredIds = $state<string[] | null>(null);
  let locallyOpenedIds = $state<string[]>([]);
  let closedIds = $state<string[]>([]);
  let selectorOpen = $state(false);
  let selectorQuery = $state("");
  let selectorMode = $state<SessionSelectorMode>("open");
  let activeSessionIds = new Map<string, string>();

  function setActiveSessionIds(value: ReadonlyMap<string, string>): void {
    activeSessionIds = new Map(value);
  }

  function activeForProject(projectPath: string): string | null {
    return activeSessionIds.get(projectPath) ?? null;
  }

  function persistActiveSessionIds(): void {
    try {
      localStorage.setItem(ACTIVE_SESSIONS_STORAGE_KEY, serializeActiveSessionIds(activeSessionIds));
    } catch {
      // Persistence failure should not prevent sessions from working for this run.
    }
  }

  function rememberActive(projectPath: string, sessionId: string): void {
    activeSessionIds.set(projectPath, sessionId);
    persistActiveSessionIds();
  }

  function forgetActive(projectPath: string): void {
    if (!activeSessionIds.delete(projectPath)) return;
    persistActiveSessionIds();
  }

  function mergeRestored(incomingIds: readonly string[] | null): void {
    restoredIds = mergeRestoredSessionTabs(
      restoredIds,
      incomingIds,
      locallyOpenedIds,
      closedIds,
    );
  }

  function replace(sourceSessionId: string | null, targetSessionId: string): void {
    const next = replaceSessionTab(
      restoredIds,
      locallyOpenedIds,
      closedIds,
      sourceSessionId,
      targetSessionId,
    );
    restoredIds = next.restoredIds;
    locallyOpenedIds = next.locallyOpenedIds;
    closedIds = next.closedIds;
  }

  function show(sessionId: string): void {
    closedIds = closedIds.filter((closedId) => closedId !== sessionId);
    if (restoredIds?.includes(sessionId) || locallyOpenedIds.includes(sessionId)) return;
    locallyOpenedIds = [...locallyOpenedIds, sessionId];
  }

  function markClosed(sessionId: string): void {
    closedIds = [...closedIds, sessionId];
    locallyOpenedIds = locallyOpenedIds.filter((openId) => openId !== sessionId);
  }

  function markClosedUnique(sessionId: string): void {
    closedIds = [...new Set([...closedIds, sessionId])];
    locallyOpenedIds = locallyOpenedIds.filter((openId) => openId !== sessionId);
  }

  function remove(sessionId: string): void {
    restoredIds = restoredIds?.filter((id) => id !== sessionId) ?? restoredIds;
    locallyOpenedIds = locallyOpenedIds.filter((id) => id !== sessionId);
    closedIds = [...new Set([...closedIds, sessionId])];
  }

  function resetTabs(): void {
    restoredIds = null;
    locallyOpenedIds = [];
    closedIds = [];
  }

  function openSelector(query = "", mode: SessionSelectorMode = "open"): void {
    selectorQuery = query;
    selectorMode = mode;
    selectorOpen = true;
  }

  function closeSelector(): void {
    selectorOpen = false;
    selectorQuery = "";
    selectorMode = "open";
  }

  return {
    get restoredIds() { return restoredIds; },
    get locallyOpenedIds() { return locallyOpenedIds; },
    get closedIds() { return closedIds; },
    get selectorOpen() { return selectorOpen; },
    get selectorQuery() { return selectorQuery; },
    get selectorMode() { return selectorMode; },
    setActiveSessionIds,
    activeForProject,
    rememberActive,
    forgetActive,
    mergeRestored,
    replace,
    show,
    markClosed,
    markClosedUnique,
    remove,
    resetTabs,
    openSelector,
    closeSelector,
  };
}
