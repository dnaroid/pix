import fs from "node:fs/promises";
import path from "node:path";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import { matchesAnyGlob } from "./_shared/glob";
import { normalizeRelativePath } from "./_shared/paths";
import type { LspServerConfig } from "./_shared/types";

export async function readTextFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

export async function fileSizeAllowed(file: string, limit: number): Promise<boolean> {
  const stat = await fs.stat(file);
  return stat.size <= limit;
}

export function languageIdForFile(server: LspServerConfig, file: string): string {
  const extension = path.extname(file);
  return server.languageIdByExtension?.[extension] ?? (extension.replace(/^\./, "") || "plaintext");
}

export function couldMatchBeforeRoot(file: string, cwd: string, include?: string[], exclude?: string[]): boolean {
  const candidates = [...new Set([normalizeRelativePath(path.relative(cwd, file)), path.basename(file)])];
  const included = !include || include.length === 0 || candidates.some((candidate) => matchesAnyGlob(include, candidate));
  if (!included) return false;
  return !candidates.some((candidate) => matchesAnyGlob(exclude, candidate));
}

export function supportsSave(capabilities: ServerCapabilities | undefined): boolean {
  const sync = capabilities?.textDocumentSync;
  if (!sync || typeof sync === "number") return false;
  return !!sync.save;
}

export function clientKey(serverId: string, root: string): string {
  return `${serverId}\u0000${root}`;
}
