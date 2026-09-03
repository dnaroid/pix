import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";

const PIX_TABS_META_KEY = "pix.tabs";

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
