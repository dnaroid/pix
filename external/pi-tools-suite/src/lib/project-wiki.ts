import { parse, type ParseError } from "jsonc-parser";

export interface ProjectWikiConfig {
  readonly path: string;
  readonly index: string;
  readonly indexPath: string;
}

export const DEFAULT_WIKI_PATH = "wiki";
export const DEFAULT_WIKI_INDEX = "index.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a relative path.`);
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.startsWith("~")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`${field} must be a relative path inside the project.`);
  }
  const parts = path.split("/");
  if (parts.includes("..")) throw new Error(`${field} cannot contain parent-directory traversal.`);
  const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (!normalized) throw new Error(`${field} must name a folder or file inside the project.`);
  return normalized;
}

function assertDurablePath(path: string, field: string): void {
  const parts = path.toLowerCase().split("/");
  if (parts.includes(".git")) throw new Error(`${field} cannot use Git metadata storage.`);
  if (parts[0] === ".pi" && (parts[1] === "artifacts" || parts[1] === "subagents")) {
    throw new Error(`${field} cannot use disposable harness storage.`);
  }
}

/** Read only: opening Wiki never creates or rewrites workspace preferences. */
export function getProjectWikiConfig(source?: string): ProjectWikiConfig {
  let wiki: Record<string, unknown> = {};
  if (source !== undefined) {
    const errors: ParseError[] = [];
    const config: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !isRecord(config)) {
      throw new Error(".pi/workspace.jsonc must contain a valid JSONC object.");
    }
    if (config.wiki !== undefined) {
      if (!isRecord(config.wiki)) throw new Error("wiki in .pi/workspace.jsonc must be an object.");
      wiki = config.wiki;
    }
  }
  const path = configPath(wiki.path === undefined ? DEFAULT_WIKI_PATH : wiki.path, "wiki.path");
  const index = configPath(wiki.index === undefined ? DEFAULT_WIKI_INDEX : wiki.index, "wiki.index");
  if (!/\.(?:md|markdown)$/iu.test(index)) {
    throw new Error("wiki.index must be a Markdown file (.md or .markdown).");
  }
  const indexPath = `${path}/${index}`;
  assertDurablePath(path, "wiki.path");
  assertDurablePath(indexPath, "wiki.index");
  return { path, index, indexPath };
}

/**
 * Resolve a document-relative Markdown target to an existing-file API path.
 * This is lexical resolution only; callers must still validate the target with
 * the project filesystem API, which owns symlink and existence checks.
 */
export function resolveWikiLink(documentPath: string, href: string): string | undefined {
  if (typeof href !== "string" || !href.trim()) return undefined;
  // Split URL metadata before decoding so a literal escaped # or ? stays in
  // the filename. Encoded separators are then checked like ordinary ones.
  const target = href.trim().split(/[?#]/u, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
  if (decoded.startsWith("/") || decoded.startsWith("~")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded) || /[\u0000-\u001f\u007f]/u.test(decoded)) return undefined;

  let document: string;
  try {
    document = configPath(documentPath, "Document path");
  } catch {
    return undefined;
  }
  if (!decoded) return document;
  const parts = document.split("/");
  parts.pop();
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}
