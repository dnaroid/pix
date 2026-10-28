/** The editor keeps document metadata outside the editable Markdown body. */
export interface WikiMarkdownParts {
  prefix: string;
  body: string;
}

export function splitWikiMarkdown(value: string): WikiMarkdownParts {
  const metadata = /^(\uFEFF?(---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:\2|\.\.\.)(?:\r?\n|$))/.exec(value);
  if (metadata?.[1]) return { prefix: metadata[1], body: value.slice(metadata[1].length) };
  if (value.startsWith("\uFEFF")) return { prefix: "\uFEFF", body: value.slice(1) };
  return { prefix: "", body: value };
}

/** Unsafe protocols must not reach either a rendered image or an opened link. */
export function isSafeWikiUrl(value: string, image = false): boolean {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  if (!scheme) return !normalized.startsWith("//");
  return image ? scheme === "https" || scheme === "http"
    : scheme === "https" || scheme === "http" || scheme === "mailto";
}

/** HTML has no lossless CommonMark editor representation: keep it in Source. */
export function unsupportedWikiMarkdownNode(tree: unknown): string | undefined {
  if (!tree || typeof tree !== "object") return undefined;
  const node = tree as { type?: unknown; children?: unknown[] };
  if (node.type === "html" || node.type === "mdxJsxFlowElement"
    || node.type === "mdxJsxTextElement" || node.type === "mdxjsEsm") {
    return "This document contains HTML or MDX. Use Source to edit it without losing markup.";
  }
  for (const child of node.children ?? []) {
    const reason = unsupportedWikiMarkdownNode(child);
    if (reason) return reason;
  }
  return undefined;
}
