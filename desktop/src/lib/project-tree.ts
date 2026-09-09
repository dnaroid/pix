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

export const PROJECT_TREE_DRAG_MIME = "application/x-pix-project-entry";

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

export function serializeProjectTreeDrag(entry: ProjectTreeEntry): string {
  return JSON.stringify({ version: 1, path: entry.path, kind: entry.kind });
}

export function parseProjectTreeDrag(value: string): ProjectTreeDragPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1) return undefined;
    if (candidate.kind !== "file" && candidate.kind !== "directory") return undefined;
    if (typeof candidate.path !== "string" || !isProjectRelativePath(candidate.path)) return undefined;
    return { path: candidate.path, kind: candidate.kind };
  } catch {
    return undefined;
  }
}

export function projectTreePromptPath(entry: ProjectTreeDragPayload): string {
  const path = entry.kind === "directory" ? `${entry.path.replace(/\/+$/u, "")}/` : entry.path;
  return path.includes("`") ? JSON.stringify(path) : `\`${path}\``;
}

export function insertProjectTreePromptPath(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  entry: ProjectTreeDragPayload,
): ProjectPathInsertion {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const reference = projectTreePromptPath(entry);
  const prefix = before && !/\s$/u.test(before) ? " " : "";
  const suffix = after && !/^\s/u.test(after) ? " " : "";
  const inserted = `${prefix}${reference}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length,
  };
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
