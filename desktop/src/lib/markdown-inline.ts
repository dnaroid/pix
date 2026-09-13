import {
  DEFAULT_MARKDOWN_RENDER_CONTEXT,
  type MarkdownRenderContext,
} from "./markdown-context";
import { escapeHtml } from "./markdown-escape";
import {
  externalLink,
  homeFileLink,
  linkForDestination,
  localMedia,
  mediaKindForPath,
  normalizeExternalHref,
  normalizeHomeFileDestination,
  normalizeInlineHomeFilePath,
  normalizeInlineProjectFileReference,
  normalizeLocalFileDestination,
  normalizeProjectFileDestination,
  normalizeRemoteImageHref,
  projectFileLink,
  projectMedia,
  remoteImage,
} from "./markdown-links";

const MAX_INLINE_DEPTH = 4;

export function renderInline(
  text: string,
  depth = 0,
  allowLinks = true,
  context: MarkdownRenderContext = DEFAULT_MARKDOWN_RENDER_CONTEXT,
): string {
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
        const homePath = allowLinks ? normalizeInlineHomeFilePath(code) : undefined;
        const projectReference = allowLinks && !homePath ? normalizeInlineProjectFileReference(code) : undefined;
        if (homePath) {
          output += homeFileLink(homePath, codeLabel);
        } else if (projectReference) {
          output += projectFileLink(projectReference.path, codeLabel, projectReference.range);
        } else {
          output += codeLabel;
        }
        index = end + markerLength;
        continue;
      }
    }

    const linkedImage = allowLinks && char === "[" && next === "!"
      ? parseLinkedImage(text, index)
      : undefined;
    if (linkedImage) {
      const source = context.remoteImages
        ? normalizeRemoteImageHref(linkedImage.image.destination)
        : undefined;
      const image = source
        ? remoteImage(source, linkedImage.image.label)
        : escapeHtml(linkedImage.image.label);
      output += linkForDestination(linkedImage.destination, image, context);
      index = linkedImage.end;
      continue;
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
        const label = depth < MAX_INLINE_DEPTH
          ? renderInline(link.label, depth + 1, false, context)
          : escapeHtml(link.label);
        const homePath = normalizeHomeFileDestination(link.destination);
        const projectPath = homePath ? undefined : normalizeProjectFileDestination(link.destination);
        const localPath = normalizeLocalFileDestination(link.destination);
        const projectKind = projectPath ? mediaKindForPath(projectPath) : undefined;
        const localKind = localPath ? mediaKindForPath(localPath) : undefined;
        if (projectPath && projectKind) {
          output += projectMedia(projectPath, label, link.label, projectKind);
        } else if (localPath && localKind) {
          output += localMedia(localPath, label, link.label, localKind);
        } else if (homePath) {
          output += homeFileLink(homePath, label);
        } else if (char === "!") {
          const source = context.remoteImages ? normalizeRemoteImageHref(link.destination) : undefined;
          output += source ? remoteImage(source, link.label) : label;
        } else {
          output += linkForDestination(link.destination, label, context);
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
    if (delimiter && depth < MAX_INLINE_DEPTH) {
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end > index + delimiter.length) {
        const content = renderInline(
          text.slice(index + delimiter.length, end),
          depth + 1,
          allowLinks,
          context,
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

function parseLinkedImage(
  text: string,
  start: number,
): {
  image: { label: string; destination: string };
  destination: string;
  end: number;
} | undefined {
  if (!text.startsWith("[![", start)) return undefined;
  const imageStart = start + 2;
  const imageLabelEnd = text.indexOf("](", imageStart + 1);
  if (imageLabelEnd < 0) return undefined;
  const image = parseLink(text, imageStart, imageLabelEnd);
  if (!image || !text.startsWith("](", image.end)) return undefined;
  const outer = parseLink(text, start, image.end);
  if (!outer) return undefined;
  return {
    image: { label: image.label, destination: image.destination },
    destination: outer.destination,
    end: outer.end,
  };
}

function countRun(text: string, start: number, marker: string): number {
  let count = 0;
  while (text[start + count] === marker) count += 1;
  return count;
}
