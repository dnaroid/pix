import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_WIKI_PAGE_BYTES, type InitializedProjectWiki } from "./wiki-findings-scan.js";

/**
 * Bounded project-file access for the `wiki_conflicts` tool. Reads reject
 * symlinks and oversized files; writes are compare-and-swap through a
 * same-directory temporary file and rename, so a concurrent editor save is
 * never silently overwritten.
 */

/** Validates a project-relative Markdown path; `wikiOnly` also requires it below the Wiki folder. */
export function projectMarkdownPath(value: unknown, wiki: InitializedProjectWiki, wikiOnly: boolean): string {
  if (typeof value !== "string") throw new Error("path must be a project-relative Markdown path.");
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!path || path.length > 1024 || path.startsWith("/") || path.startsWith("~") || /[\u0000-\u001f\u007f:]/u.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))
    || !/\.(?:md|markdown)$/iu.test(path)) {
    throw new Error("path must be a project-relative Markdown path without hidden or parent segments.");
  }
  if (wikiOnly && !path.startsWith(`${wiki.path}/`)) throw new Error(`path must be a page inside ${wiki.path}/.`);
  return path;
}

async function regularFile(root: string, path: string): Promise<string> {
  const file = join(root, path);
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  if (info.size > MAX_WIKI_PAGE_BYTES) throw new Error(`${path} exceeds the Wiki page size limit.`);
  if (await realpath(file) !== file) throw new Error(`${path} resolves outside its project path.`);
  return file;
}

export async function readProjectPage(wiki: InitializedProjectWiki, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const content = await readFile(await regularFile(wiki.root, path), "utf8");
  signal?.throwIfAborted();
  return content;
}

/** Writes `content` only when the page still equals `expected`; false when it changed. */
export async function writeProjectPageIfUnchanged(wiki: InitializedProjectWiki, path: string, content: string,
  expected: string): Promise<boolean> {
  const file = await regularFile(wiki.root, path);
  if (await readFile(file, "utf8") !== expected) return false;
  const mode = (await lstat(file)).mode & 0o777;
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", mode);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    // Narrow the race with an editor save as far as a plain filesystem allows.
    if (await readFile(file, "utf8") !== expected) return false;
    await rename(temp, file);
    return true;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
