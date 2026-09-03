import { highlightCode } from "./syntax-highlight";
import {
  attachmentKind,
  filePathFromUri,
  mimeTypeForName,
  type AttachmentKind,
} from "./attachments";

const MAX_BLOCK_DEPTH = 4;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type Fence = {
  marker: "`" | "~";
  length: number;
  language: string;
};

type TableAlignment = "center" | "left" | "right" | undefined;

/**
 * Render the deliberately small Markdown subset used by the transcript.
 * All source text is safely escaped here or by the syntax highlighter before
 * the result reaches Svelte's `{@html}`.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  return renderBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}

function renderBlocks(lines: readonly string[], depth: number): string {
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index] ?? "", fence)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const source = body.join("\n");
      if (fence.language.toLowerCase() === "mermaid") {
        const escapedSource = escapeHtml(source);
        output.push(
          `<figure class="mermaid-diagram" data-mermaid-source="${escapeAttribute(source)}">`
          + '<div class="mermaid-canvas" role="img" aria-label="Mermaid diagram" aria-busy="true"></div>'
          + `<pre class="mermaid-fallback"><code>${escapedSource}</code></pre>`
          + "</figure>",
        );
        continue;
      }
      const highlighted = highlightCode(source, fence.language);
      output.push(`<pre><code class="highlighted-code" data-language="${highlighted.language}">${highlighted.html}</code></pre>`);
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      output.push(table.html);
      index += table.lineCount;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^ {0,3}>[ \t]?(.*)$/);
        if (!match) break;
        quoteLines.push(match[1] ?? "");
        index += 1;
      }
      const quote = depth < MAX_BLOCK_DEPTH
        ? renderBlocks(quoteLines, depth + 1)
        : `<p>${renderInline(quoteLines.join("\n"))}</p>`;
      output.push(`<blockquote>${quote}</blockquote>`);
      continue;
    }

    const list = parseList(lines, index);
    if (list) {
      output.push(list.html);
      index += list.lineCount;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }

  return output.join("");
}

function parseFence(line: string): Fence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/);
  if (!match?.[1]) return undefined;
  return {
    marker: match[1][0] as Fence["marker"],
    length: match[1].length,
    language: (match[2] ?? "").trim().split(/\s+/, 1)[0] ?? "",
  };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  let markerCount = 0;
  while (trimmed[markerCount] === fence.marker) markerCount += 1;
  return markerCount >= fence.length && trimmed.slice(markerCount).trim() === "";
}

function parseList(lines: readonly string[], start: number): { html: string; lineCount: number } | undefined {
  const first = listItem(lines[start] ?? "");
  if (!first) return undefined;

  const items: string[] = [];
  let index = start;
  const startAttribute = first.ordered && first.number !== 1 ? ` start="${first.number}"` : "";

  while (index < lines.length) {
    const item = listItem(lines[index] ?? "");
    if (!item || item.ordered !== first.ordered) break;

    const task = item.text.match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task) {
      const checked = task[1]?.toLowerCase() === "x" ? " checked" : "";
      items.push(`<li class="task-item"><input type="checkbox" disabled${checked}>${renderInline(task[2] ?? "")}</li>`);
    } else {
      items.push(`<li>${renderInline(item.text)}</li>`);
    }
    index += 1;
  }

  const tag = first.ordered ? "ol" : "ul";
  return { html: `<${tag}${startAttribute}>${items.join("")}</${tag}>`, lineCount: index - start };
}

function listItem(line: string): { ordered: boolean; number: number; text: string } | undefined {
  const unordered = line.match(/^ {0,3}[-+*][ \t]+(.+)$/);
  if (unordered) return { ordered: false, number: 1, text: unordered[1] ?? "" };
  const ordered = line.match(/^ {0,3}(\d{1,9})[.)][ \t]+(.+)$/);
  if (!ordered) return undefined;
  return { ordered: true, number: Number(ordered[1]), text: ordered[2] ?? "" };
}

function parseTable(lines: readonly string[], start: number): { html: string; lineCount: number } | undefined {
  if (start + 1 >= lines.length) return undefined;
  const header = splitTableRow(lines[start] ?? "");
  const delimiter = splitTableRow(lines[start + 1] ?? "");
  if (header.length === 0 || delimiter.length !== header.length) return undefined;

  const alignments: TableAlignment[] = [];
  for (const cell of delimiter) {
    const marker = cell.trim();
    if (!/^:?-+:?$/.test(marker)) return undefined;
    alignments.push(tableAlignment(marker));
  }

  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && (lines[index] ?? "").trim()) {
    const row = splitTableRow(lines[index] ?? "");
    if (row.length === 0) break;
    rows.push(Array.from({ length: header.length }, (_, column) => row[column] ?? ""));
    index += 1;
  }

  const cells = (row: readonly string[], tag: "td" | "th") => row.map((cell, column) => {
    const alignment = alignments[column];
    const className = alignment ? ` class="align-${alignment}"` : "";
    return `<${tag}${className}>${renderInline(cell.trim())}</${tag}>`;
  }).join("");
  const body = rows.length > 0
    ? `<tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody>`
    : "";
  return {
    html: `<div class="table-scroll"><table><thead><tr>${cells(header, "th")}</tr></thead>${body}</table></div>`,
    lineCount: index - start,
  };
}

function tableAlignment(marker: string): TableAlignment {
  const left = marker.startsWith(":");
  const right = marker.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const source = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = source.endsWith("|") ? source.slice(0, -1) : source;
  const cells: string[] = [];
  let cell = "";
  let code = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "`") {
      code = !code;
      cell += char;
    } else if (char === "|" && !code) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    parseFence(line)
    || /^ {0,3}(?:#{1,6}[ \t]+|>|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.test(line)
    || /^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)
    || parseTable(lines, index),
  );
}

function renderInline(text: string, depth = 0, allowLinks = true): string {
  let output = "";
  let index = 0;
  let nextLinkLabelEnd = text.indexOf("](");

  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (char === "\\" && next && /[\\`*_[\]{}()#+.!~|>-]/.test(next)) {
      output += escapeHtml(next);
      index += 2;
      continue;
    }

    if (char === "`") {
      const markerLength = countRun(text, index, "`");
      const marker = "`".repeat(markerLength);
      const end = text.indexOf(marker, index + markerLength);
      if (end >= 0) {
        const code = text.slice(index + markerLength, end).replace(/\n/g, " ");
        const codeLabel = `<code>${escapeHtml(code)}</code>`;
        const projectPath = allowLinks ? normalizeInlineProjectFilePath(code) : undefined;
        output += projectPath ? projectFileLink(projectPath, codeLabel) : codeLabel;
        index = end + markerLength;
        continue;
      }
    }

    let linkStart = -1;
    if (allowLinks && char === "!" && next === "[") {
      linkStart = index + 1;
    } else if (allowLinks && char === "[") {
      linkStart = index;
    }
    while (nextLinkLabelEnd >= 0 && nextLinkLabelEnd < linkStart) {
      nextLinkLabelEnd = text.indexOf("](", nextLinkLabelEnd + 2);
    }
    if (linkStart >= 0 && nextLinkLabelEnd >= 0) {
      const link = parseLink(text, linkStart, nextLinkLabelEnd);
      if (link) {
        const label = depth < MAX_BLOCK_DEPTH
          ? renderInline(link.label, depth + 1, false)
          : escapeHtml(link.label);
        const projectPath = normalizeProjectFileDestination(link.destination);
        const localPath = normalizeLocalFileDestination(link.destination);
        const projectKind = projectPath ? mediaKindForPath(projectPath) : undefined;
        const localKind = localPath ? mediaKindForPath(localPath) : undefined;
        if (projectPath && projectKind) {
          output += projectMedia(projectPath, label, link.label, projectKind);
        } else if (localPath && localKind) {
          output += localMedia(localPath, label, link.label, localKind);
        } else if (char === "!") {
          output += label;
        } else {
          output += linkForDestination(link.destination, label);
        }
        index = link.end;
        continue;
      }
      nextLinkLabelEnd = text.indexOf("](", nextLinkLabelEnd + 2);
    }

    const automaticLink = allowLinks ? parseAutomaticLink(text, index) : undefined;
    if (automaticLink) {
      output += externalLink(automaticLink.href, escapeHtml(automaticLink.label));
      index = automaticLink.end;
      continue;
    }

    const delimiter = inlineDelimiter(text, index);
    if (delimiter && depth < MAX_BLOCK_DEPTH) {
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end > index + delimiter.length) {
        const content = renderInline(
          text.slice(index + delimiter.length, end),
          depth + 1,
          allowLinks,
        );
        if (delimiter.length === 3) {
          output += `<strong><em>${content}</em></strong>`;
        } else {
          const tag = delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em";
          output += `<${tag}>${content}</${tag}>`;
        }
        index = end + delimiter.length;
        continue;
      }
    }

    if (char === "\n") {
      output += "<br>";
      index += 1;
      continue;
    }

    let end = index + 1;
    while (
      end < text.length
      && !/[\\`!*_[\]~\n]/.test(text[end] ?? "")
      && !(allowLinks && hasAutomaticLinkPrefix(text, end))
    ) {
      end += 1;
    }
    output += escapeHtml(text.slice(index, end));
    index = end;
  }

  return output;
}

function externalLink(href: string, label: string): string {
  return `<a href="${escapeAttribute(href)}" data-external-link rel="noopener noreferrer">${label}</a>`;
}

function linkForDestination(destination: string, label: string): string {
  const externalHref = normalizeExternalHref(destination);
  if (externalHref) return externalLink(externalHref, label);

  const projectPath = normalizeProjectFileDestination(destination);
  if (projectPath) return projectFileLink(projectPath, label);

  const localPath = normalizeLocalFileDestination(destination);
  if (localPath) return localFileLink(localPath, label);

  return label;
}

function projectFileLink(path: string, label: string): string {
  const escapedPath = escapeAttribute(path);
  return `<a href="#" data-project-file="${escapedPath}" title="Preview ${escapedPath}">${label}</a>`;
}

function localFileLink(path: string, label: string): string {
  const escapedPath = escapeAttribute(path);
  return `<a href="#" data-local-file="${escapedPath}" title="Open ${escapedPath}">${label}</a>`;
}

function mediaKindForPath(path: string): Exclude<AttachmentKind, "file"> | undefined {
  const kind = attachmentKind(mimeTypeForName(path));
  return kind === "file" ? undefined : kind;
}

function projectMedia(
  path: string,
  label: string,
  accessibleLabel: string,
  kind: Exclude<AttachmentKind, "file">,
): string {
  const escapedPath = escapeAttribute(path);
  const escapedLabel = escapeAttribute(accessibleLabel);
  const loading = '<span class="markdown-media-status">Loading preview…</span>';
  const frame = kind === "image"
    ? `<a href="#" class="markdown-media-frame" data-project-file="${escapedPath}" title="Preview ${escapedPath}" aria-label="Preview ${escapedLabel}">${loading}</a>`
    : `<span class="markdown-media-frame">${loading}</span>`;
  return `<span class="markdown-media" data-project-media="${kind}" data-project-file="${escapedPath}" data-project-media-label="${escapedLabel}">`
    + frame
    + `<span class="markdown-media-caption">${projectFileLink(path, label)}</span>`
    + "</span>";
}

function localMedia(
  path: string,
  label: string,
  accessibleLabel: string,
  kind: Exclude<AttachmentKind, "file">,
): string {
  const escapedPath = escapeAttribute(path);
  const escapedLabel = escapeAttribute(accessibleLabel);
  const loading = '<span class="markdown-media-status">Loading preview…</span>';
  const frame = kind === "image"
    ? `<a href="#" class="markdown-media-frame" data-local-file="${escapedPath}" title="Preview ${escapedPath}" aria-label="Preview ${escapedLabel}">${loading}</a>`
    : `<span class="markdown-media-frame">${loading}</span>`;
  return `<span class="markdown-media" data-local-media="${kind}" data-local-file="${escapedPath}" data-local-media-label="${escapedLabel}">`
    + frame
    + `<span class="markdown-media-caption">${localFileLink(path, label)}</span>`
    + "</span>";
}

function normalizeInlineProjectFilePath(code: string): string | undefined {
  const candidate = code.trim().replace(/:\d+(?::\d+)?$/, "");
  const path = normalizeProjectFileDestination(candidate);
  if (!path) return undefined;

  const fileName = path.split("/").at(-1) ?? "";
  const hasFileExtension = /\.[A-Za-z\d_-]{1,16}$/.test(fileName);
  const hasExplicitRelativePrefix = candidate.startsWith("./") || candidate.startsWith(".\\");
  const isConventionalFileName = /^(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG|Gemfile|Rakefile)$/i.test(fileName);
  return hasFileExtension || hasExplicitRelativePrefix || isConventionalFileName ? path : undefined;
}

function parseAutomaticLink(
  text: string,
  start: number,
): { href: string; label: string; end: number } | undefined {
  if (!hasAutomaticLinkPrefix(text, start) || !isAutomaticLinkBoundary(text, start)) {
    return undefined;
  }

  let end = start;
  while (end < text.length && !/[\s<>"'`]/.test(text[end] ?? "")) end += 1;
  end = trimAutomaticLinkEnd(text, start, end);
  const label = text.slice(start, end);
  const href = normalizeExternalHref(label);
  return href ? { href, label, end } : undefined;
}

function hasAutomaticLinkPrefix(text: string, start: number): boolean {
  const prefix = text.slice(start, start + 8).toLowerCase();
  return prefix.startsWith("https://")
    || prefix.startsWith("http://")
    || prefix.startsWith("mailto:");
}

function isAutomaticLinkBoundary(text: string, start: number): boolean {
  if (start === 0) return true;
  return /[\s([{]/.test(text[start - 1] ?? "");
}

function trimAutomaticLinkEnd(text: string, start: number, initialEnd: number): number {
  let end = initialEnd;
  while (end > start && /[.,!?;:*]/.test(text[end - 1] ?? "")) end -= 1;

  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    let openingCount = 0;
    let closingCount = 0;
    for (let index = start; index < end; index += 1) {
      if (text[index] === opening) openingCount += 1;
      if (text[index] === closing) closingCount += 1;
    }
    while (end > start && text[end - 1] === closing && closingCount > openingCount) {
      end -= 1;
      closingCount -= 1;
    }
  }

  return end;
}

function inlineDelimiter(text: string, index: number): string {
  if (text.startsWith("***", index) || text.startsWith("___", index)) {
    return text.slice(index, index + 3);
  }
  if (text.startsWith("**", index) || text.startsWith("__", index)) {
    return text.slice(index, index + 2);
  }
  if (text.startsWith("~~", index)) return "~~";
  const char = text[index];
  return char === "*" || char === "_" ? char : "";
}

function parseLink(
  text: string,
  start: number,
  labelEnd: number,
): { label: string; destination: string; end: number } | undefined {
  if (text[start] !== "[") return undefined;

  let depth = 0;
  for (let index = labelEnd + 2; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\") {
      index += 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth > 0) {
        depth -= 1;
      } else {
        return {
          label: text.slice(start + 1, labelEnd),
          destination: text.slice(labelEnd + 2, index).trim(),
          end: index + 1,
        };
      }
    }
  }
  return undefined;
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
  if (!value || value.startsWith("/") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
    return undefined;
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  return normalized || undefined;
}

function countRun(text: string, start: number, marker: string): number {
  let count = 0;
  while (text[start + count] === marker) count += 1;
  return count;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
