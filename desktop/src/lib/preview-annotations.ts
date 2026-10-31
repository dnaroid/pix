import type { FileAnnotation } from "./acp-pix-extensions";
import { escapeAttribute, escapeHtml } from "./markdown-escape";

/**
 * Inline file commentary for Preview source. Highlighted source is one
 * `<span class="sh__line">` per source line, separated by literal newlines;
 * a note is inserted as its own non-selectable row above its target line.
 * Notes never carry the `sh__line` class, so line numbers, range scrolling
 * and selection context keep counting real source lines only.
 */
export interface PreviewAnnotationHeader {
  /** `summary`: module overview; `status`: progress; `error`: failure message. */
  readonly kind: "summary" | "status" | "error";
  readonly label?: string;
  readonly text: string;
}

export function insertPreviewAnnotations(html: string, annotations: readonly FileAnnotation[], header?: PreviewAnnotationHeader): string {
  const top = header?.text.trim() ? headerRow(header) : "";
  if (annotations.length === 0) return top ? `${top}\n${html}` : html;
  const rows = html.split("\n");
  const byLine = new Map<number, string>();
  for (const annotation of annotations) {
    if (!Number.isInteger(annotation.line) || annotation.line < 1 || annotation.line > rows.length) continue;
    const text = annotation.text.trim();
    if (!text) continue;
    byLine.set(annotation.line, byLine.has(annotation.line) ? `${byLine.get(annotation.line)} ${text}` : text);
  }
  if (byLine.size === 0) return top ? `${top}\n${html}` : html;
  const output: string[] = top ? [top] : [];
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

function headerRow(header: PreviewAnnotationHeader): string {
  const role = header.kind === "error" ? "alert" : header.kind === "status" ? "status" : "note";
  const label = header.label ? `<span class="preview-annotation-label">${escapeHtml(header.label)}</span>` : "";
  const body = header.text.trim().split(/\n{2,}/u).map((paragraph) => `<span class="preview-annotation-paragraph">${renderInlineNote(paragraph)}</span>`).join("");
  return `<span class="preview-annotation preview-annotation-${header.kind}" role="${role}">`
    + `<span class="preview-annotation-body">${label}${body}</span></span>`;
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
