import katex from "katex";
import { escapeHtml } from "./markdown-escape";

const MAX_MATH_LENGTH = 8_192;
const MATH_CACHE_LIMIT = 128;
const renderedMathCache = new Map<string, string | null>();

export type InlineMath = { source: string; raw: string; end: number };
export type DisplayMathBlock = { source: string; raw: string; lineCount: number; complete: boolean };

/** Recognize math delimiters without consuming code spans or Markdown escapes. */
export function inlineMathAt(text: string, start: number): InlineMath | undefined {
  const opener = text.startsWith("\\(", start) ? "\\("
    : text.startsWith("\\[", start) ? "\\["
      : text[start] === "$" && text[start + 1] !== "$" ? "$" : undefined;
  if (!opener) return undefined;
  const closer = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : "$";
  const from = start + opener.length;
  if (opener === "$" && (!text[from] || /\s/u.test(text[from] ?? ""))) return undefined;

  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\n") break;
    if (text[index] === "\\" && text[index + 1] && !text.startsWith(closer, index)) {
      index += 1;
      continue;
    }
    if (!text.startsWith(closer, index)) continue;
    if (opener === "$" && /\s/u.test(text[index - 1] ?? "")) continue;
    const source = text.slice(from, index);
    if (!source.trim() || source.length > MAX_MATH_LENGTH) return undefined;
    const end = index + closer.length;
    return { source, raw: text.slice(start, end), end };
  }
  return undefined;
}

/** A display math block can span lines; incomplete streaming blocks remain readable. */
export function displayMathBlockAt(lines: readonly string[], start: number): DisplayMathBlock | undefined {
  const opening = /^ {0,3}(\\\[|\$\$)(.*)$/u.exec(lines[start] ?? "");
  if (!opening) return undefined;
  const closer = opening[1] === "\\[" ? "\\]" : "$$";
  const firstLine = opening[2] ?? "";
  if (firstLine.includes(closer) && firstLine.slice(firstLine.lastIndexOf(closer) + closer.length).trim()) {
    // The formula is embedded in prose; let the inline parser handle it.
    return undefined;
  }
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = index === start ? opening[2] ?? "" : lines[index] ?? "";
    const closeIndex = line.lastIndexOf(closer);
    if (closeIndex >= 0 && !line.slice(closeIndex + closer.length).trim()
      && (closeIndex === 0 || line[closeIndex - 1] !== "\\")) {
      body.push(line.slice(0, closeIndex));
      return {
        source: body.join("\n").trim(),
        raw: lines.slice(start, index + 1).join("\n"),
        lineCount: index - start + 1,
        complete: true,
      };
    }
    body.push(line);
  }
  return {
    source: body.join("\n").trim(),
    raw: lines.slice(start).join("\n"),
    lineCount: lines.length - start,
    complete: false,
  };
}

/** KaTeX escapes source text itself; failures show escaped source, never raw HTML. */
export function renderMathHtml(source: string, displayMode: boolean): string | undefined {
  if (!source.trim() || source.length > MAX_MATH_LENGTH) return undefined;
  const key = `${displayMode ? "D" : "I"}:${source}`;
  if (renderedMathCache.has(key)) return renderedMathCache.get(key) ?? undefined;
  let rendered: string | undefined;
  try {
    rendered = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1_000,
      maxSize: 10,
      output: "htmlAndMathml",
    });
  } catch {
    // Invalid or incomplete formulas are displayed as source rather than disappearing.
  }
  if (renderedMathCache.size >= MATH_CACHE_LIMIT) {
    renderedMathCache.delete(renderedMathCache.keys().next().value ?? "");
  }
  renderedMathCache.set(key, rendered ?? null);
  return rendered;
}

export function renderInlineMath(math: InlineMath): string {
  const html = renderMathHtml(math.source, false);
  return html
    ? `<span class="markdown-math-inline">${html}</span>`
    : `<code class="markdown-math-fallback">${escapeHtml(math.raw)}</code>`;
}

export function renderDisplayMath(block: DisplayMathBlock): string {
  const html = block.complete ? renderMathHtml(block.source, true) : undefined;
  return html
    ? `<div class="markdown-math-display">${html}</div>`
    : `<pre class="markdown-math-fallback">${escapeHtml(block.raw)}</pre>`;
}
