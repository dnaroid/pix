import type { KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";

/** Mirrors the Rust `wiki_file_dates` result; times are Unix epoch milliseconds. */
export interface WikiFileDates {
  readonly createdAt: number | null;
  readonly committedAt: number | null;
  readonly modifiedAt: number | null;
  readonly uncommitted: boolean;
  readonly linesCommittedAt: number | null;
  readonly linesUncommitted: boolean;
  readonly tracked: boolean;
}

export interface WikiFileDatesRequest {
  readonly path: string;
  /** Raw-file lines of the quotation; absent when the quote cannot be located uniquely. */
  readonly lines?: { readonly startLine: number; readonly endLine: number };
}

/**
 * Best known time of the quoted text: uncommitted quoted lines are as new as the
 * file on disk; otherwise the newest commit of the lines, then of the file.
 */
export function wikiQuoteTime(dates: WikiFileDates): number | null {
  if (dates.linesUncommitted || (!dates.tracked && dates.uncommitted)) return dates.modifiedAt;
  return dates.linesCommittedAt ?? dates.committedAt ?? dates.modifiedAt;
}

/** Index (0 or 1) of the side whose quoted text is newer, or null when unknown or equal. */
export function newerWikiSide(dates: readonly [WikiFileDates | null, WikiFileDates | null]): 0 | 1 | null {
  const [first, second] = dates.map(side => side ? wikiQuoteTime(side) : null);
  if (first == null || second == null || first === second) return null;
  return first > second ? 0 : 1;
}

export function formatWikiDate(time: number, language?: KnowledgeReportLanguage): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(time));
}
