import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
import { knowledgeEvidenceText as knowledgeSourceEvidenceText, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import { isWorkspaceProjectFilePath, type ProjectFileLineRange } from "./project-files";

export type KnowledgeCitationMatch =
  | { readonly status: "matched"; readonly range: ProjectFileLineRange; readonly quote: string }
  | { readonly status: "source" | "missing" | "ambiguous" | "invalid" };

export function isKnowledgeDocumentPath(path: string): boolean {
  return typeof path === "string" && path.length <= 4096
    && isWorkspaceProjectFilePath(path)
    && !/^[a-z][a-z0-9+.-]*:/iu.test(path)
    && !/[\\\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..")
    && /\.(?:md|markdown)$/iu.test(path);
}

/** A report link is a bounded literal citation, never an arbitrary URL or line-selection instruction. */
export function isNavigableKnowledgeCitation(citation: KnowledgeCitation): boolean {
  return isKnowledgeDocumentPath(citation?.path)
    && typeof citation.quote === "string" && citation.quote.trim().length > 0 && citation.quote.length <= 48_000
    && Number.isSafeInteger(citation.startLine) && citation.startLine > 0
    && Number.isSafeInteger(citation.endLine) && citation.endLine >= citation.startLine;
}

/** The current file, not saved line numbers, determines whether evidence can be highlighted. */
export function matchKnowledgeCitation(content: string, path: string, citation: KnowledgeCitation): KnowledgeCitationMatch {
  if (!isNavigableKnowledgeCitation(citation) || path !== citation.path) return { status: "invalid" };
  // Report metadata can repeat the quotation. Locate it in the same logical
  // body that Preview renders, not inside saved report JSON or old raw lines.
  const text = stripKnowledgeCheckStamp(content).replace(/\r\n?/gu, "\n");
  const quote = citation.quote.replace(/\r\n?/gu, "\n");
  const start = text.indexOf(quote);
  if (start < 0) {
    // Retrieved excerpts can span a blanked metadata line. Keep a truthful
    // source-text fallback for that case without guessing a rendered location.
    const evidence = knowledgeSourceEvidenceText(content).replace(/\r\n?/gu, "\n");
    const rawStart = evidence.indexOf(quote);
    return { status: rawStart >= 0 && evidence.indexOf(quote, rawStart + 1) < 0 ? "source" : "missing" };
  }
  if (text.indexOf(quote, start + 1) >= 0) return { status: "ambiguous" };
  const lineAt = (offset: number) => 1 + (text.slice(0, offset).match(/\n/gu)?.length ?? 0);
  return { status: "matched", quote, range: { startLine: lineAt(start), endLine: lineAt(start + quote.length - 1) } };
}

export type KnowledgeEvidenceDisplay = "idle" | "exact" | "section" | "source" | "missing" | "ambiguous" | "invalid";

export function knowledgeEvidenceText(status: KnowledgeEvidenceDisplay, language?: KnowledgeReportLanguage): string {
  const ru = language === "ru";
  if (status === "exact") return ru ? "Подсвечена точная цитата из отчёта." : "The exact quotation from the report is highlighted.";
  if (status === "section") return ru
    ? "Цитата найдена в текущем файле. Подсвечен содержащий её раздел; точный исходный текст приведён ниже."
    : "The quotation exists in the current file. Its containing section is highlighted; the exact source text is shown below.";
  if (status === "source") return ru
    ? "Цитата найдена в текущем файле, но точно выделить её в предпросмотре не удалось. Исходный текст приведён ниже."
    : "The quotation exists in the current file, but could not be highlighted precisely in Preview. The source text is shown below.";
  if (status === "missing") return ru
    ? "Цитата из отчёта больше не найдена в этом файле. Он мог измениться; прежние номера строк не подсвечиваются."
    : "The report quotation is no longer present in this file. It may have changed; the old line numbers are not highlighted.";
  if (status === "ambiguous") return ru
    ? "Цитата теперь встречается в файле несколько раз. Однозначно выбрать доказательство нельзя; подсветка не показана."
    : "The quotation now occurs more than once. Its evidence location is ambiguous, so no passage is highlighted.";
  if (status === "invalid") return ru ? "Ссылка на доказательство некорректна." : "The evidence reference is invalid.";
  return "";
}
