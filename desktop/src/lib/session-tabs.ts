import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";

const PIX_TABS_META_KEY = "pix.tabs";
export const ACTIVE_SESSIONS_STORAGE_KEY = "pix.desktop.activeSessions";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
