import type { FileAnnotation } from "./acp-pix-extensions";
import { escapeAttribute, escapeHtml } from "./markdown-escape";

/**
 * Inline file commentary for Preview source. Highlighted source is one
 * `<span class="sh__line">` per source line, separated by literal newlines;
 * a note is inserted as its own non-selectable row above its target line.
 * Notes never carry the `sh__line` class, so line numbers, range scrolling
 * and selection context keep counting real source lines only.
 */
export function insertPreviewAnnotations(html: string, annotations: readonly FileAnnotation[]): string {
  if (annotations.length === 0) return html;
  const rows = html.split("\n");
  const byLine = new Map<number, string>();
  for (const annotation of annotations) {
    if (!Number.isInteger(annotation.line) || annotation.line < 1 || annotation.line > rows.length) continue;
    const text = annotation.text.trim();
    if (!text) continue;
    byLine.set(annotation.line, byLine.has(annotation.line) ? `${byLine.get(annotation.line)} ${text}` : text);
  }
  if (byLine.size === 0) return html;
  const output: string[] = [];
  rows.forEach((row, index) => {
    const note = byLine.get(index + 1);
    if (note !== undefined) output.push(annotationRow(index + 1, note));
    output.push(row);
  });
  return output.join("\n");
}

function annotationRow(line: number, text: string): string {
  return `<span class="preview-annotation" data-annotation-line="${line}" role="note" aria-label="${escapeAttribute(`Note for line ${line}`)}">`
    + `<span class="preview-annotation-body">${renderInlineNote(text)}</span></span>`;
}

/** Minimal inline Markdown for notes: `code`, **bold** and *emphasis*; everything else is escaped text. */
export function renderInlineNote(text: string): string {
  return text.split(/(`[^`\n]+`)/u).map((part) => {
    if (/^`[^`\n]+`$/u.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part)
      .replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/gu, "$1<em>$2</em>");
  }).join("");
}
