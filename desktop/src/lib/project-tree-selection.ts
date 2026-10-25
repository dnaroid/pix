import type { ProjectTreeEntry } from "./project-tree";

export function projectSelectionRange(paths: readonly string[], anchor: string | null, target: string): string[] {
  const end = paths.indexOf(target);
  const start = anchor === null ? end : paths.indexOf(anchor);
  if (end < 0) return [];
  return paths.slice(Math.min(start < 0 ? end : start, end), Math.max(start < 0 ? end : start, end) + 1).filter(Boolean);
}

/** A selected folder already includes its descendants in a filesystem operation. */
export function projectSelectionRoots(entries: readonly ProjectTreeEntry[]): ProjectTreeEntry[] {
  const unique = [...new Map(entries.filter((entry) => entry.path).map((entry) => [entry.path, entry])).values()];
  return unique.filter((entry) => !unique.some((parent) => parent.kind === "directory"
    && entry.path.startsWith(`${parent.path}/`)));
}
