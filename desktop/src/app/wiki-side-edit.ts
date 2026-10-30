import type { KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
import { applyWikiSideEdit, type WikiEditableBlock } from "../lib/wiki-side-edit";

export interface WikiSideEditRequest {
  readonly path: string;
  /** Block captured when editing started; a changed block is never overwritten. */
  readonly block: WikiEditableBlock;
  readonly text: string;
}

interface SaveWikiSideEditOptions {
  /** Reads the raw current project file, including hidden report metadata. */
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  /** Compare-and-swap write fenced to the project; false when not written (it reports its own failures). */
  readonly write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
  readonly isCurrent: () => boolean;
  readonly language?: KnowledgeReportLanguage;
  readonly signal?: AbortSignal;
}

/** Saves an inline edit of one comparison side. True when the file holds the edit. */
export async function saveWikiSideEdit(request: WikiSideEditRequest, options: SaveWikiSideEditOptions): Promise<boolean> {
  const signal = options.signal ?? new AbortController().signal;
  const content = await options.read(request.path, signal);
  if (!options.isCurrent()) return false;
  const next = await applyWikiSideEdit(content, request.block, request.text);
  if (next === undefined) {
    throw new Error(options.language === "ru"
      ? `Фрагмент в ${request.path} изменился после начала правки. Ваш текст сохранён в редакторе; обновите сравнение и повторите.`
      : `The fragment in ${request.path} changed after editing started. Your text is kept in the editor; refresh the comparison and try again.`);
  }
  if (next === content) return true;
  if (!options.isCurrent()) return false;
  return options.write(request.path, next, content);
}
