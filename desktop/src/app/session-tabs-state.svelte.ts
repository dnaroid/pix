import {
  ACTIVE_SESSIONS_STORAGE_KEY,
  mergeRestoredSessionTabs,
  replaceSessionTab,
  restoreDesktopSessionTabs,
  serializeActiveSessionIds,
  serializeSessionTabIds,
  SESSION_TABS_STORAGE_KEY,
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
  let persistedSessionTabIds = new Map<string, string[]>();
  let restoredWorkspace: string | null = null;

  function setActiveSessionIds(value: ReadonlyMap<string, string>): void {
    activeSessionIds = new Map(value);
  }

  function setSessionTabIds(value: ReadonlyMap<string, readonly string[]>): void {
    persistedSessionTabIds = new Map(
      [...value].map(([workspace, ids]) => [workspace, [...ids]]),
    );
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

  function sessionTabsForProject(projectPath: string): string[] | null {
    const value = persistedSessionTabIds.get(projectPath);
    return value === undefined ? null : [...value];
  }

  function persistSessionTabIds(): void {
    try {
      localStorage.setItem(SESSION_TABS_STORAGE_KEY, serializeSessionTabIds(persistedSessionTabIds));
    } catch {
      // Persistence failure should not prevent sessions from working for this run.
    }
  }

  function currentVisibleIds(): string[] | null {
    if (restoredIds === null) return null;
    const closed = new Set(closedIds);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const sessionId of [...restoredIds, ...locallyOpenedIds]) {
      if (closed.has(sessionId) || seen.has(sessionId)) continue;
      seen.add(sessionId);
      result.push(sessionId);
    }
    return result;
  }

  function persistCurrentTabs(): void {
    if (!restoredWorkspace) return;
    const current = currentVisibleIds();
    if (current === null) return;
    persistedSessionTabIds.set(restoredWorkspace, current);
    persistSessionTabIds();
  }

  function mergeRestored(
    projectPath: string,
    incomingIds: readonly string[] | null,
    availableIds: readonly string[],
  ): void {
    if (restoredWorkspace !== projectPath) {
      restoredWorkspace = projectPath;
      const initial = restoreDesktopSessionTabs(
        sessionTabsForProject(projectPath),
        incomingIds,
        availableIds,
      );
      restoredIds = initial.restoredIds;
      locallyOpenedIds = initial.locallyOpenedIds;
      closedIds = initial.closedIds;
      persistCurrentTabs();
      return;
    }

    restoredIds = mergeRestoredSessionTabs(
      restoredIds,
      incomingIds,
      locallyOpenedIds,
      closedIds,
    );
    const available = new Set(availableIds);
    restoredIds = restoredIds?.filter((sessionId) => available.has(sessionId)) ?? restoredIds;
    locallyOpenedIds = locallyOpenedIds.filter((sessionId) => available.has(sessionId));
    closedIds = closedIds.filter((sessionId) => available.has(sessionId));
    persistCurrentTabs();
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
    persistCurrentTabs();
  }

  function show(sessionId: string): void {
    closedIds = closedIds.filter((closedId) => closedId !== sessionId);
    if (!restoredIds?.includes(sessionId) && !locallyOpenedIds.includes(sessionId)) {
      locallyOpenedIds = [...locallyOpenedIds, sessionId];
    }
    persistCurrentTabs();
  }

  function markClosed(sessionId: string): void {
    closedIds = [...closedIds, sessionId];
    locallyOpenedIds = locallyOpenedIds.filter((openId) => openId !== sessionId);
    persistCurrentTabs();
  }

  function markClosedUnique(sessionId: string): void {
    closedIds = [...new Set([...closedIds, sessionId])];
    locallyOpenedIds = locallyOpenedIds.filter((openId) => openId !== sessionId);
    persistCurrentTabs();
  }

  function remove(sessionId: string): void {
    restoredIds = restoredIds?.filter((id) => id !== sessionId) ?? restoredIds;
    locallyOpenedIds = locallyOpenedIds.filter((id) => id !== sessionId);
    closedIds = [...new Set([...closedIds, sessionId])];
    persistCurrentTabs();
  }

  function resetTabs(): void {
    restoredIds = null;
    locallyOpenedIds = [];
    closedIds = [];
    restoredWorkspace = null;
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
    setSessionTabIds,
    activeForProject,
    sessionTabsForProject,
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
