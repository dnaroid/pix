import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { SessionTreeRow } from "./session-tabs";

/** Search bypasses hierarchy and collapsed branches entirely. */
export function flatSessionRow(session: SessionInfo): SessionTreeRow {
  return { session, treePrefix: "", depth: 0, ancestorIds: [], ancestorContinues: [],
    isLast: true, hasChildren: false };
}

/** Filter before pagination, preserving the geometry of the complete tree. */
export function expandedSessionRows(
  rows: readonly SessionTreeRow[],
  collapsed: ReadonlySet<string>,
): SessionTreeRow[] {
  return rows.filter((row) => !row.ancestorIds.some((id) => collapsed.has(id)));
}

export function sessionRowsRelated(row: SessionTreeRow, active: SessionTreeRow | null): boolean {
  if (!active) return false;
  const id = row.session.sessionId;
  const activeId = active.session.sessionId;
  return id === activeId || active.ancestorIds.at(-1) === id || row.ancestorIds.at(-1) === activeId;
}
