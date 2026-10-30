import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS } from "./contract.js";
import {
  MAX_WIKI_FINDINGS, filterWikiFindings, mergeWikiFindings, projectWikiPageFindings, summarizeWikiFindings,
  type WikiFinding, type WikiFindingFilter, type WikiFindingSummary, type WikiPageFinding,
} from "./findings.js";
import { KNOWLEDGE_REPORT_PREFIX, MAX_KNOWLEDGE_REPORT_BYTES, MAX_KNOWLEDGE_STAMP_BYTES, readKnowledgeReport } from "./stamp.js";

/**
 * Read-only scan of saved Wiki contradiction reports for agent tools. It reads
 * page files only; it never calls a model or search and never writes.
 */

export const MAX_WIKI_SCAN_FILES = 5_000;
export const MAX_WIKI_PAGE_BYTES = MAX_KNOWLEDGE_DOCUMENT_CHARS * 4 + MAX_KNOWLEDGE_REPORT_BYTES + MAX_KNOWLEDGE_STAMP_BYTES;
const CONFIG_PATH = ".pi/workspace.jsonc";

export interface InitializedProjectWiki {
  /** Real project root. */
  readonly root: string;
  /** Project-relative Wiki folder. */
  readonly path: string;
  readonly indexPath: string;
}

export interface WikiFindingsScan {
  readonly findings: readonly WikiFinding[];
  /** Totals across every merged finding, before filtering. */
  readonly summary: WikiFindingSummary;
  /** More pages or findings existed than were scanned/merged. */
  readonly truncated: boolean;
  readonly scannedPages: number;
  /** Pages skipped as oversized, unreadable or not regular files. */
  readonly skippedPages: number;
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a relative path.`);
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").includes("..")) {
    throw new Error(`${field} must be a relative path inside the project.`);
  }
  const normalized = path.split("/").filter(part => part && part !== ".").join("/");
  if (!normalized) throw new Error(`${field} must name a folder or file inside the project.`);
  const parts = normalized.toLowerCase().split("/");
  if (parts.includes(".git") || (parts[0] === ".pi" && (parts[1] === "artifacts" || parts[1] === "subagents"))) {
    throw new Error(`${field} cannot use Git metadata or disposable harness storage.`);
  }
  return normalized;
}

/**
 * Same contract as the project Wiki prompt: `.pi/workspace.jsonc` (optional,
 * defaults `wiki/index.md`) and an existing index file inside the project.
 * Returns undefined when the Wiki is not initialized; throws on invalid configuration.
 */
export async function initializedProjectWiki(cwd: string): Promise<InitializedProjectWiki | undefined> {
  const root = await realpath(cwd);
  let source: string | undefined;
  try {
    const file = await realpath(join(root, CONFIG_PATH));
    if (!contained(root, file)) throw new Error("Wiki configuration is outside the project.");
    source = await readFile(file, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let wiki: Record<string, unknown> = {};
  if (source !== undefined) {
    const errors: ParseError[] = [];
    const config: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !record(config)) throw new Error(`${CONFIG_PATH} must contain a valid JSONC object.`);
    if (config.wiki !== undefined) {
      if (!record(config.wiki)) throw new Error(`wiki in ${CONFIG_PATH} must be an object.`);
      wiki = config.wiki;
    }
  }
  const path = configPath(wiki.path ?? "wiki", "wiki.path");
  const index = configPath(wiki.index ?? "index.md", "wiki.index");
  if (!/\.(?:md|markdown)$/iu.test(index)) throw new Error("wiki.index must be a Markdown file.");
  const indexPath = `${path}/${index}`;
  try {
    const real = await realpath(join(root, indexPath));
    if (!contained(root, real) || !(await stat(real)).isFile()) return undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  return { root, path, indexPath };
}

/** Project-relative Markdown pages below the Wiki folder; symlinks and dot entries are skipped. */
async function wikiPages(root: string, wikiPath: string, signal?: AbortSignal): Promise<{ pages: string[]; truncated: boolean }> {
  const top = join(root, wikiPath);
  if (await realpath(top) !== top) return { pages: [], truncated: false };
  const pending = [wikiPath], pages: string[] = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const folder = pending.pop()!;
    let dir;
    try { dir = await opendir(join(root, folder)); } catch (error) { if (missing(error)) continue; throw error; }
    for await (const entry of dir) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(?:md|markdown)$/iu.test(entry.name)) {
        if (pages.length >= MAX_WIKI_SCAN_FILES) { await dir.close().catch(() => undefined); return { pages: pages.sort(), truncated: true }; }
        pages.push(path);
      }
    }
  }
  return { pages: pages.sort(), truncated: false };
}

async function pageFindings(root: string, path: string): Promise<readonly WikiPageFinding[] | undefined> {
  const file = join(root, path);
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_WIKI_PAGE_BYTES) return undefined;
  const content = await readFile(file, "utf8");
  if (!content.includes(KNOWLEDGE_REPORT_PREFIX)) return [];
  const report = await readKnowledgeReport(content);
  return report ? projectWikiPageFindings(report, path) : [];
}

export async function scanWikiFindings(wiki: InitializedProjectWiki, filter: WikiFindingFilter = {},
  signal?: AbortSignal): Promise<WikiFindingsScan> {
  const { pages, truncated: pagesTruncated } = await wikiPages(wiki.root, wiki.path, signal);
  const projected: (readonly WikiPageFinding[])[] = [];
  let skippedPages = 0;
  for (const path of pages) {
    signal?.throwIfAborted();
    try {
      const findings = await pageFindings(wiki.root, path);
      if (findings) projected.push(findings);
      else skippedPages++;
    } catch (error) {
      if (!missing(error)) skippedPages++;
    }
  }
  const merged = mergeWikiFindings(projected, MAX_WIKI_FINDINGS);
  return {
    findings: filterWikiFindings(merged.findings, filter),
    summary: summarizeWikiFindings(merged.findings),
    truncated: pagesTruncated || merged.truncated,
    scannedPages: pages.length - skippedPages,
    skippedPages,
  };
}
