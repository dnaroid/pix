/** Classifies a window selection for the Explain Code / Translate assistant. */

export type SelectionAssistAction = "explain" | "explain-file" | "translate";

export interface SelectionAssistTarget {
  readonly action: SelectionAssistAction;
  readonly text: string;
  /** Surrounding source lines (explain only). */
  readonly context?: string;
  /** Source file path from the Preview surface (explain only). */
  readonly path?: string;
  /** Viewport rectangle used to anchor the result popover. */
  readonly anchor: { readonly left: number; readonly top: number; readonly bottom: number };
}

export const SELECTION_ASSIST_MAX_TEXT = 20_000;
/** ACP accepts up to 120,000 characters for a whole-file explanation. */
export const EXPLAIN_FILE_MAX_TEXT = 120_000;
const TRUNCATION_NOTE = "\n\n[… file truncated for explanation …]";
const CONTEXT_LINES = 15;
const MAX_CONTEXT = 8_000;

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

/** Explain applies to Preview source code; Translate to chat and rendered Markdown Preview text. */
export function selectionAssistTarget(selection: Selection | null): SelectionAssistTarget | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim() || text.length > SELECTION_ASSIST_MAX_TEXT) return null;
  const range = selection.getRangeAt(0);
  const common = elementOf(range.commonAncestorContainer);
  if (!common) return null;
  const rect = range.getBoundingClientRect();
  const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };

  const surface = common.closest<HTMLElement>("[data-preview-source-path]");
  const code = surface?.querySelector<HTMLElement>(".preview-code");
  if (surface && code && (code.contains(common) || common.contains(code))) {
    const rows = Array.from(code.children).filter((row): row is HTMLElement => row instanceof HTMLElement && row.matches(".sh__line"));
    const rowIndex = (node: Node) => {
      const row = elementOf(node)?.closest(".sh__line");
      return row ? rows.indexOf(row as HTMLElement) : -1;
    };
    const start = rowIndex(range.startContainer);
    const end = rowIndex(range.endContainer);
    let context: string | undefined;
    if (start >= 0 && end >= start) {
      context = rows
        .slice(Math.max(0, start - CONTEXT_LINES), Math.min(rows.length, end + CONTEXT_LINES + 1))
        .map((row) => row.textContent ?? "")
        .join("\n")
        .slice(0, MAX_CONTEXT);
    }
    const path = surface.dataset.previewSourcePath;
    return { action: "explain", text, anchor, ...(context ? { context } : {}), ...(path ? { path } : {}) };
  }

  if (common.closest(".transcript-pane, .preview-markdown-content")) return { action: "translate", text, anchor };
  return null;
}

/** Whole-file explanation from the Preview header; very large files are explained from their beginning. */
export function explainFileTarget(path: string, content: string, anchor: SelectionAssistTarget["anchor"]): SelectionAssistTarget | null {
  if (!content.trim()) return null;
  const text = content.length > EXPLAIN_FILE_MAX_TEXT
    ? content.slice(0, EXPLAIN_FILE_MAX_TEXT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE
    : content;
  return { action: "explain-file", text, path, anchor };
}
