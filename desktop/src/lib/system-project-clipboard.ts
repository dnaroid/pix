import { invoke, isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { decodeProjectEntryClipboard } from "./project-entry-clipboard";

/** Native reads take one snapshot of text and Finder file URLs; never infer files from text paths. */
export function readSystemProjectClipboard(): Promise<string | null> {
  return isTauri() ? invoke<string | null>("read_project_entry_clipboard") : readText();
}

/** Copy publishes both native file URLs and the Pix reference; Cut stays Pix-only. */
export function writeSystemProjectClipboard(text: string): Promise<void> {
  const copied = decodeProjectEntryClipboard(text);
  if (!copied) return Promise.reject(new Error("Invalid Pix file clipboard reference."));
  if (!isTauri() || copied.operation === "move") return writeText(text);
  return invoke<void>("write_project_entry_clipboard", {
    workspace: copied.workspace,
    paths: (copied.entries ?? [copied]).map((entry) => entry.path),
  });
}
