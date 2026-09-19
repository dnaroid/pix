import {
  attachmentKind,
  filePathFromUri,
  mimeTypeForName,
  type AttachmentKind,
} from "./attachments";
import type { ProjectFileLineRange } from "./project-files";
import type { MarkdownRenderContext } from "./markdown-context";
import { escapeAttribute } from "./markdown-escape";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function externalLink(href: string, label: string): string {
  return `<a href="${escapeAttribute(href)}" data-external-link rel="noopener noreferrer">${label}</a>`;
}

export function remoteImage(src: string, alt: string): string {
  return `<img class="markdown-remote-image" src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

export function linkForDestination(
  destination: string,
  label: string,
  context: MarkdownRenderContext,
): string {
  const anchor = context.headingAnchors ? normalizeHeadingAnchor(destination) : undefined;
  if (anchor) {
    const escaped = escapeAttribute(anchor);
    return `<a href="#${escaped}" data-markdown-anchor="${escaped}">${label}</a>`;
  }

  const externalHref = normalizeExternalHref(destination);
  if (externalHref) return externalLink(externalHref, label);

  const homePath = normalizeHomeFileDestination(destination);
  if (homePath) return homeFileLink(homePath, label);

  const projectReference = normalizeProjectFileReference(destination);
  if (projectReference) return projectFileLink(projectReference.path, label, projectReference.range);

  const localPath = normalizeLocalFileDestination(destination);
  if (localPath) return localFileLink(localPath, label);

  return label;
}

export function projectFileLink(path: string, label: string, range?: ProjectFileLineRange): string {
  const escapedPath = escapeAttribute(path);
  const rangeAttributes = range
    ? ` data-project-file-start-line="${range.startLine}" data-project-file-end-line="${range.endLine}"`
    : "";
  return `<span class="markdown-file-candidate" data-project-file-candidate="${escapedPath}"${rangeAttributes}>${label}</span>`;
}

export function localFileLink(path: string, label: string): string {
  const escapedPath = escapeAttribute(path);
  return `<span class="markdown-file-candidate" data-local-file-candidate="${escapedPath}">${label}</span>`;
}

export function homeFileLink(path: string, label: string): string {
  const escapedPath = escapeAttribute(path);
  return `<span class="markdown-file-candidate" data-local-file-candidate="${escapedPath}">${label}</span>`;
}

export function mediaKindForPath(path: string): Exclude<AttachmentKind, "file"> | undefined {
  const kind = attachmentKind(mimeTypeForName(path));
  return kind === "file" ? undefined : kind;
}

export function projectMedia(
  path: string,
  label: string,
  accessibleLabel: string,
  kind: Exclude<AttachmentKind, "file">,
): string {
  const escapedPath = escapeAttribute(path);
  const escapedLabel = escapeAttribute(accessibleLabel);
  const loading = '<span class="markdown-media-status">Loading preview…</span>';
  const frame = `<span class="markdown-media-frame" aria-label="Preview ${escapedLabel}">${loading}</span>`;
  return `<span class="markdown-media" data-project-media="${kind}" data-project-file="${escapedPath}" data-project-media-label="${escapedLabel}">`
    + frame
    + `<span class="markdown-media-caption">${projectFileLink(path, label)}</span>`
    + "</span>";
}

export function localMedia(
  path: string,
  label: string,
  accessibleLabel: string,
  kind: Exclude<AttachmentKind, "file">,
): string {
  const escapedPath = escapeAttribute(path);
  const escapedLabel = escapeAttribute(accessibleLabel);
  const loading = '<span class="markdown-media-status">Loading preview…</span>';
  const frame = `<span class="markdown-media-frame" aria-label="Preview ${escapedLabel}">${loading}</span>`;
  return `<span class="markdown-media" data-local-media="${kind}" data-local-file="${escapedPath}" data-local-media-label="${escapedLabel}">`
    + frame
    + `<span class="markdown-media-caption">${localFileLink(path, label)}</span>`
    + "</span>";
}

export function normalizeInlineProjectFileReference(
  code: string,
): { path: string; range?: ProjectFileLineRange } | undefined {
  const trimmed = code.trim();
  const suffix = /^(.*?):([1-9]\d*)(?:(?:-([1-9]\d*))|(?::([1-9]\d*)))?$/u.exec(trimmed);
  const candidate = suffix?.[1] ?? trimmed;
  const path = normalizeProjectFileDestination(candidate);
  if (!path) return undefined;

  const fileName = path.split("/").at(-1) ?? "";
  const hasFileExtension = /\.[A-Za-z\d_-]{1,16}$/.test(fileName);
  const hasExplicitRelativePrefix = candidate.startsWith("./") || candidate.startsWith(".\\");
  const isConventionalFileName = /^(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG|Gemfile|Rakefile)$/i.test(fileName);
  if (!hasFileExtension && !hasExplicitRelativePrefix && !isConventionalFileName) return undefined;

  const startLine = suffix?.[2] ? Number(suffix[2]) : undefined;
  const explicitEnd = suffix?.[3] ? Number(suffix[3]) : undefined;
  const range = startLine
    ? {
        startLine: Math.min(startLine, explicitEnd ?? startLine),
        endLine: Math.max(startLine, explicitEnd ?? startLine),
      }
    : undefined;
  return { path, ...(range ? { range } : {}) };
}

export function normalizeInlineHomeFilePath(code: string): string | undefined {
  const candidate = code.trim().replace(/:\d+(?::\d+)?$/, "");
  const path = normalizeHomeFileDestination(candidate);
  if (!path) return undefined;
  const fileName = path.split("/").at(-1) ?? "";
  return /\.[A-Za-z\d_-]{1,16}$/.test(fileName) ? path : undefined;
}

export function normalizeRemoteImageHref(destination: string): string | undefined {
  const href = normalizeExternalHref(destination);
  if (!href) return undefined;
  const protocol = new URL(href).protocol;
  return protocol === "http:" || protocol === "https:" ? href : undefined;
}

export function normalizeHeadingAnchor(destination: string): string | undefined {
  if (!destination.startsWith("#") || destination.length === 1) return undefined;
  try {
    const anchor = decodeURIComponent(destination.slice(1));
    return /[\u0000-\u001f\u007f]/.test(anchor) ? undefined : anchor;
  } catch {
    return undefined;
  }
}

export function normalizeExternalHref(destination: string): string | undefined {
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination)) return undefined;
  try {
    const url = new URL(destination);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a file URL to an absolute local path without treating other URL schemes as files. */
export function normalizeLocalFileDestination(destination: string): string | undefined {
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination)) return undefined;
  let value = destination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (!/^file:\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:" || url.username || url.password || url.port) return undefined;
  const path = filePathFromUri(url.href);
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return absolute ? path : undefined;
}

/** Normalize a Markdown destination that can safely be resolved inside the active workspace. */
export function normalizeProjectFileDestination(destination: string): string | undefined {
  return normalizeProjectFileReference(destination)?.path;
}

/** Normalize a confined project path and an optional GitHub-style source-line fragment. */
export function normalizeProjectFileReference(
  destination: string,
): { path: string; range?: ProjectFileLineRange } | undefined {
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination)) return undefined;
  let value = destination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  let pathEnd = value.length;
  if (queryStart >= 0) pathEnd = Math.min(pathEnd, queryStart);
  if (fragmentStart >= 0) pathEnd = Math.min(pathEnd, fragmentStart);
  const pathValue = value.slice(0, pathEnd);
  const fragment = fragmentStart >= 0 ? value.slice(fragmentStart + 1) : undefined;
  try {
    value = decodeURIComponent(pathValue);
  } catch {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  value = value.replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value === "~" || value.startsWith("~/") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
    return undefined;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) return undefined;

  const range = fragment ? projectFileLineRange(fragment) : undefined;
  return { path: normalized, ...(range ? { range } : {}) };
}

function projectFileLineRange(fragment: string): ProjectFileLineRange | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(decoded);
  if (!match) return undefined;

  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine) {
    return undefined;
  }
  return { startLine, endLine };
}

/** Normalize a user-home path without expanding it in the untrusted renderer. */
export function normalizeHomeFileDestination(destination: string): string | undefined {
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination)) return undefined;
  let value = destination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  value = value.split(/[?#]/, 1)[0] ?? "";
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  value = value.replaceAll("\\", "/");
  if (!value.startsWith("~/")) return undefined;
  const segments = value.slice(2).split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  return normalized ? `~/${normalized}` : undefined;
}
