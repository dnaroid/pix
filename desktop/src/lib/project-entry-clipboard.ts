import type { ProjectTreeEntry } from "./project-tree";

const FORMAT = "pix-project-entry";
export interface ProjectEntryClipboard {
  workspace: string;
  path: string;
  kind: "file" | "directory";
}

export function encodeProjectEntryClipboard(workspace: string, entry: ProjectTreeEntry): string {
  return JSON.stringify({ format: FORMAT, version: 1, workspace, path: entry.path, kind: entry.kind });
}

export function decodeProjectEntryClipboard(text: string | null): ProjectEntryClipboard | null {
  if (!text || text.length > 32_768) return null;
  try {
    const value = JSON.parse(text);
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
  // This is only a menu hint. The backend checks canonical paths, including aliases.
  return copied.kind !== "directory" || copied.workspace !== workspace
    || (destination !== copied.path && !destination.startsWith(`${copied.path}/`));
}

/** Action-triggered reads only; replacement and teardown invalidate late results. */
export function createProjectEntryClipboardReader(read: () => Promise<string | null>) {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    async refresh(publish: (value: ProjectEntryClipboard | null) => void) {
      const request = ++generation;
      try {
        const value = decodeProjectEntryClipboard(await read());
        if (request === generation) publish(value);
      } catch {
        if (request === generation) publish(null);
      }
    },
  };
}
