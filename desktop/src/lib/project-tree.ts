export type ProjectTreeEntryKind = "file" | "directory";

export interface ProjectTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: ProjectTreeEntryKind;
}

export interface ProjectTreeRow {
  readonly entry: ProjectTreeEntry;
  readonly depth: number;
}

export function flattenProjectTree(
  rootEntries: readonly ProjectTreeEntry[],
  entriesByDirectory: Readonly<Record<string, readonly ProjectTreeEntry[]>>,
  expandedDirectories: ReadonlySet<string>,
): ProjectTreeRow[] {
  const rows: ProjectTreeRow[] = [];
  appendProjectTreeRows(rows, rootEntries, entriesByDirectory, expandedDirectories, 0);
  return rows;
}

function appendProjectTreeRows(
  rows: ProjectTreeRow[],
  entries: readonly ProjectTreeEntry[],
  entriesByDirectory: Readonly<Record<string, readonly ProjectTreeEntry[]>>,
  expandedDirectories: ReadonlySet<string>,
  depth: number,
): void {
  for (const entry of entries) {
    rows.push({ entry, depth });
    if (entry.kind !== "directory" || !expandedDirectories.has(entry.path)) continue;
    appendProjectTreeRows(
      rows,
      entriesByDirectory[entry.path] ?? [],
      entriesByDirectory,
      expandedDirectories,
      depth + 1,
    );
  }
}
