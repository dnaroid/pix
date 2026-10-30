import type { WikiFinding, WikiFindingGroup } from "./wiki-conflicts-index";

/** One visible inbox row. Page grouping can show one finding under several pages. */
export interface WikiFindingRow {
  readonly key: string;
  readonly groupKey: string;
  readonly finding: WikiFinding;
}

export function wikiFindingRowKey(groupKey: string, findingId: string): string {
  return `${groupKey}\u0000${findingId}`;
}

export function flattenWikiFindingGroups(groups: readonly WikiFindingGroup[]): WikiFindingRow[] {
  return groups.flatMap(group => group.findings.map(finding => ({
    key: wikiFindingRowKey(group.key, finding.id), groupKey: group.key, finding,
  })));
}

/**
 * Keeps the current row when it is still visible, otherwise the same finding in
 * another group, otherwise the requested finding, otherwise the first row.
 */
export function resolveWikiFindingSelection(
  rows: readonly WikiFindingRow[],
  selectedKey: string | null,
  preferredFindingId?: string | null,
): string | null {
  if (!rows.length) return null;
  if (preferredFindingId) {
    const requested = rows.find(row => row.finding.id === preferredFindingId);
    if (requested) return requested.key;
  }
  if (selectedKey) {
    if (rows.some(row => row.key === selectedKey)) return selectedKey;
    const id = selectedKey.slice(selectedKey.indexOf("\u0000") + 1);
    const same = rows.find(row => row.finding.id === id);
    if (same) return same.key;
  }
  return rows[0]!.key;
}

/** j/k and arrow keys: bounded movement, no wrap-around. */
export function moveWikiFindingRow(rows: readonly WikiFindingRow[], selectedKey: string | null, delta: number): string | null {
  if (!rows.length) return null;
  const index = rows.findIndex(row => row.key === selectedKey);
  if (index < 0) return rows[delta < 0 ? rows.length - 1 : 0]!.key;
  return rows[Math.min(rows.length - 1, Math.max(0, index + delta))]!.key;
}

/** [ and ]: first row of the previous/next group. */
export function moveWikiFindingGroup(rows: readonly WikiFindingRow[], selectedKey: string | null, delta: -1 | 1): string | null {
  if (!rows.length) return null;
  const starts = rows.filter((row, index) => index === 0 || rows[index - 1]!.groupKey !== row.groupKey);
  const current = rows.find(row => row.key === selectedKey);
  const groupIndex = current ? starts.findIndex(row => row.groupKey === current.groupKey) : -1;
  if (groupIndex < 0) return starts[delta < 0 ? starts.length - 1 : 0]!.key;
  return starts[Math.min(starts.length - 1, Math.max(0, groupIndex + delta))]!.key;
}
