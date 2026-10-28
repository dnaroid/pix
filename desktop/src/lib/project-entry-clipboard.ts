import { projectTreeAbsolutePath, type ProjectTreeEntry } from "./project-tree";

const FORMAT = "pix-project-entry";
export interface ProjectEntryClipboard {
  workspace: string;
  path: string;
  kind: "file" | "directory";
  entries?: Pick<ProjectTreeEntry, "path" | "kind">[];
  operation?: "copy" | "move";
}

export function encodeProjectEntryClipboard(workspace: string, entry: ProjectTreeEntry, entries?: ProjectTreeEntry[], operation: "copy" | "move" = "copy"): string {
  if (entries && (entries.length > 1 || operation === "move")) {
    return JSON.stringify({ format: FORMAT, version: 2, workspace, entries: entries.map(({ path, kind }) => ({ path, kind })), operation });
  }
  return JSON.stringify({ format: FORMAT, version: 1, workspace, path: entry.path, kind: entry.kind });
}

export function decodeProjectEntryClipboard(text: string | null): ProjectEntryClipboard | null {
  if (!text || text.length > 32_768) return null;
  try {
    const value = JSON.parse(text);
    if (value?.format === FORMAT && value.version === 2) {
      if (!Array.isArray(value.entries) || !value.entries.length || value.entries.length > 1000
        || !["copy", "move"].includes(value.operation)) return null;
      const entries = value.entries.map((entry: unknown) => decodeProjectEntryClipboard(JSON.stringify({
        ...(entry && typeof entry === "object" ? entry : {}), format: FORMAT, version: 1, workspace: value.workspace,
      })));
      if (entries.some((entry: ProjectEntryClipboard | null) => !entry)) return null;
      return { ...entries[0], entries: entries.map(({ path, kind }: ProjectEntryClipboard) => ({ path, kind })), operation: value.operation };
    }
    if (value?.format !== FORMAT || value.version !== 1
      || typeof value.workspace !== "string" || !value.workspace.startsWith("/") || value.workspace.includes("\0")
      || typeof value.path !== "string" || value.path.includes("\0") || value.path.includes("\\")
      || value.path.split("/").some((part: string) => !part || part === "." || part === "..")
      || (value.kind !== "file" && value.kind !== "directory")) return null;
    return { workspace: value.workspace, path: value.path, kind: value.kind };
  } catch {
    return null;
  }
}

export function canPasteProjectEntry(copied: ProjectEntryClipboard | null, workspace: string, destination: string): boolean {
  if (!copied) return false;
  if (copied.operation === "move" && copied.workspace !== workspace) return false;
  if (copied.entries) return copied.entries.every((entry) => canPasteProjectEntry({ workspace: copied.workspace, ...entry }, workspace, destination));
  // This is only a menu hint. The backend checks canonical paths, including aliases.
  const source = projectTreeAbsolutePath(copied.workspace, copied.path);
  const target = projectTreeAbsolutePath(workspace, destination).replace(/\/$/u, "");
  return copied.kind !== "directory" || (target !== source && !target.startsWith(`${source}/`));
}

/** Action-triggered reads only; replacement and teardown invalidate late results. */
export function createProjectEntryClipboardReader(read: () => Promise<string | null>, report: (error: unknown) => void = () => {}) {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    async refresh(publish: (value: ProjectEntryClipboard | null) => void) {
      const request = ++generation;
      try {
        const value = decodeProjectEntryClipboard(await read());
        if (request === generation) publish(value);
      } catch (error) {
        report(error);
        if (request === generation) publish(null);
      }
    },
  };
}
