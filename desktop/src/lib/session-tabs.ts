import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import { linearFocusIndex } from "./keyboard-navigation";

const PIX_TABS_META_KEY = "pix.tabs";
export const ACTIVE_SESSIONS_STORAGE_KEY = "pix.desktop.activeSessions";

export type SessionTabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** Resolve roving focus for the horizontal session tab strip without activating a tab. */
export function sessionTabFocusIndex(
  currentIndex: number,
  key: string,
  tabCount: number,
): number | null {
  return linearFocusIndex(currentIndex, key, tabCount, "horizontal", true);
}

/** Read the ordered TUI tab ids from Pix's namespaced ACP response metadata. */
export function restoredTabSessionIds(response: ListSessionsResponse): string[] | null {
  const metadata = response._meta?.[PIX_TABS_META_KEY];
  if (!isRecord(metadata) || !Array.isArray(metadata.sessionIds)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of metadata.sessionIds) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** Resolve the session that should be opened automatically for this workspace. */
export function startupSessionId(
  response: ListSessionsResponse,
  desktopSessionId: string | null,
): string | null {
  const availableIds = new Set(response.sessions.map((session) => session.sessionId));
  if (desktopSessionId && availableIds.has(desktopSessionId)) return desktopSessionId;

  const metadata = response._meta?.[PIX_TABS_META_KEY];
  if (!isRecord(metadata) || typeof metadata.activeSessionId !== "string") return null;
  return availableIds.has(metadata.activeSessionId) ? metadata.activeSessionId : null;
}

/** Parse the last active desktop session for each workspace from local storage. */
export function parseActiveSessionIds(serialized: string | null): Map<string, string> {
  if (!serialized) return new Map();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch {
    return new Map();
  }
}

export function serializeActiveSessionIds(sessionIds: ReadonlyMap<string, string>): string {
  return JSON.stringify(Object.fromEntries(sessionIds));
}

/** Select and order sessions shown in the top strip independently of the full selector list. */
export function buildTabSessions(
  sessions: readonly SessionInfo[],
  restoredIds: readonly string[] | null,
  locallyOpenedIds: readonly string[],
  closedIds: readonly string[],
  activeSessionId: string | null,
): SessionInfo[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const closed = new Set(closedIds);
  const orderedIds = restoredIds === null ? sessions.map((session) => session.sessionId) : [...restoredIds];
  orderedIds.push(...locallyOpenedIds);
  if (activeSessionId) orderedIds.push(activeSessionId);

  const result: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const sessionId of orderedIds) {
    if (seen.has(sessionId) || closed.has(sessionId)) continue;
    seen.add(sessionId);
    const session = byId.get(sessionId);
    if (session) result.push(session);
  }
  return result;
}

/** Keep Desktop-owned replacements in their current slots while accepting TUI tab changes. */
export function mergeRestoredSessionTabs(
  currentIds: readonly string[] | null,
  incomingIds: readonly string[] | null,
  locallyOpenedIds: readonly string[],
  closedIds: readonly string[],
): string[] | null {
  if (currentIds === null) return incomingIds === null ? null : [...incomingIds];
  if (incomingIds === null) return [...currentIds];
  const incoming = new Set(incomingIds);
  const local = new Set(locallyOpenedIds);
  const closed = new Set(closedIds);
  const merged = currentIds.filter((sessionId) => (
    !closed.has(sessionId) && (incoming.has(sessionId) || local.has(sessionId))
  ));
  const seen = new Set([...merged, ...locallyOpenedIds, ...closedIds]);
  for (const sessionId of incomingIds) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    merged.push(sessionId);
  }
  return merged;
}

export interface ReplacedSessionTabState {
  readonly restoredIds: string[] | null;
  readonly locallyOpenedIds: string[];
  readonly closedIds: string[];
}

/**
 * Replace the current tab's session identity without opening an additional tab.
 * If the target is already represented by another tab, the source tab simply
 * disappears and the existing target tab becomes the selected one.
 */
export function replaceSessionTab(
  restoredIds: readonly string[] | null,
  locallyOpenedIds: readonly string[],
  closedIds: readonly string[],
  sourceSessionId: string | null,
  targetSessionId: string,
): ReplacedSessionTabState {
  if (!sourceSessionId) {
    const targetRepresented = (restoredIds?.includes(targetSessionId) ?? false)
      || locallyOpenedIds.includes(targetSessionId);
    return {
      restoredIds: restoredIds === null ? null : [...restoredIds],
      locallyOpenedIds: restoredIds !== null && !targetRepresented
        ? [...locallyOpenedIds, targetSessionId]
        : [...locallyOpenedIds],
      closedIds: closedIds.filter((sessionId) => sessionId !== targetSessionId),
    };
  }
  if (sourceSessionId === targetSessionId) {
    return {
      restoredIds: restoredIds === null ? null : [...restoredIds],
      locallyOpenedIds: [...locallyOpenedIds],
      closedIds: closedIds.filter((sessionId) => sessionId !== targetSessionId),
    };
  }

  const replaceStable = (ids: readonly string[]): { ids: string[]; replaced: boolean } => {
    const next: string[] = [];
    const seen = new Set<string>();
    let replaced = false;
    for (const sessionId of ids) {
      const value = sessionId === sourceSessionId ? targetSessionId : sessionId;
      if (sessionId === sourceSessionId) replaced = true;
      if (seen.has(value)) continue;
      seen.add(value);
      next.push(value);
    }
    return { ids: next, replaced };
  };

  const targetWasRepresented = (restoredIds?.includes(targetSessionId) ?? false)
    || locallyOpenedIds.includes(targetSessionId);
  const restored = restoredIds === null
    ? { ids: [] as string[], replaced: false }
    : replaceStable(restoredIds);
  const local = replaceStable(locallyOpenedIds);
  if (restoredIds !== null && !targetWasRepresented && !local.ids.includes(targetSessionId)) {
    local.ids.push(targetSessionId);
  }

  return {
    restoredIds: restoredIds === null ? null : restored.ids,
    locallyOpenedIds: local.ids,
    closedIds: [...new Set([
      ...closedIds.filter((sessionId) => sessionId !== targetSessionId),
      sourceSessionId,
    ])],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
