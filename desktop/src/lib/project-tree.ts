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

export const PROJECT_TREE_DROP_TARGET_SELECTOR = "[data-pix-project-path-drop-target]";
export const PROJECT_TREE_DRAG_STATE_EVENT = "pix-project-path-drag-state";
export const PROJECT_TREE_DROP_EVENT = "pix-project-path-drop";

export interface ProjectTreeDragPayload {
  readonly path: string;
  readonly kind: ProjectTreeEntryKind;
}

export interface ProjectPathInsertion {
  readonly text: string;
  readonly cursor: number;
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

/** Resolve the nearest visible parent row for keyboard Left-arrow navigation. */
export function projectTreeParentIndex(rows: readonly ProjectTreeRow[], index: number): number | null {
  const row = rows[index];
  if (!row || row.depth <= 0) return null;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if ((rows[candidate]?.depth ?? -1) === row.depth - 1) return candidate;
  }
  return null;
}

export function serializeProjectTreeDrag(entry: ProjectTreeEntry): string {
  return JSON.stringify({ version: 1, path: entry.path, kind: entry.kind });
}

export function projectTreeDragPayload(entry: ProjectTreeEntry): ProjectTreeDragPayload {
  return { path: entry.path, kind: entry.kind };
}

export function parseProjectTreeDrag(value: string): ProjectTreeDragPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1) return undefined;
    return projectTreeDragPayloadFromUnknown(candidate);
  } catch {
    return undefined;
  }
}

export function projectTreeDragPayloadFromUnknown(value: unknown): ProjectTreeDragPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "file" && candidate.kind !== "directory") return undefined;
  if (typeof candidate.path !== "string" || !isProjectRelativePath(candidate.path)) return undefined;
  return { path: candidate.path, kind: candidate.kind };
}

export function projectTreePromptPath(entry: ProjectTreeDragPayload): string {
  return quotedPromptPath(entry.path);
}

export function insertProjectTreePromptPath(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  entry: ProjectTreeDragPayload,
): ProjectPathInsertion {
  return insertPromptPaths(text, selectionStart, selectionEnd, [entry.path]);
}

export function insertPromptPaths(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  paths: readonly string[],
): ProjectPathInsertion {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const reference = paths.filter((path) => path.length > 0).map(quotedPromptPath).join(" ");
  if (!reference) return { text, cursor: start };
  const prefix = before && !/\s$/u.test(before) ? " " : "";
  const suffix = after && !/^\s/u.test(after) ? " " : "";
  const inserted = `${prefix}${reference}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length,
  };
}

function quotedPromptPath(path: string): string {
  return JSON.stringify(path);
}

function isProjectRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[/\\]/u.test(path)) return false;
  return !path.split(/[\\/]/u).some((part) => part === ".." || part === "");
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
