import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { knowledgeEvidenceText, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import { matchKnowledgeCitation, type KnowledgeCitationMatch } from "./knowledge-citation";

/** Lines shown before and after a located quotation. */
export const WIKI_CITATION_CONTEXT_RADIUS = 8;
/** Upper bound of rendered lines per side, so a huge quotation cannot flood the pane. */
export const MAX_WIKI_CITATION_CONTEXT_LINES = 120;

export type WikiCitationContext =
  | {
    readonly status: "matched";
    /** Whole Markdown blocks before the quotation, rendered dimmed. */
    readonly before: string;
    /** The blocks containing the quotation, expanded to block boundaries. */
    readonly quote: string;
    readonly after: string;
    /** One-based source lines of the quote blocks. */
    readonly startLine: number;
    readonly endLine: number;
    /**
     * Zero-based `<tr>` indices (header row = 0) of the quoted lines when the quote
     * block is a single Markdown table and only part of it is quoted.
     */
    readonly tableRows?: { readonly first: number; readonly last: number };
    /** Nearest Markdown heading above the quotation, outside fenced code. */
    readonly heading?: string;
    readonly truncated: boolean;
  }
  /** The quotation is absent, repeated, only in metadata, or the citation is unusable. */
  | { readonly status: Exclude<KnowledgeCitationMatch["status"], "matched"> };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;

function nearestHeading(lines: readonly string[], beforeIndex: number): string | undefined {
  let fence: string | undefined;
  let heading: string | undefined;
  for (let index = 0; index < beforeIndex; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = HEADING.exec(line);
    if (match) heading = match[1];
  }
  return heading;
}

/** Blank lines outside fenced code separate Markdown blocks. */
function blockBoundaries(lines: readonly string[]): boolean[] {
  let fence: string | undefined;
  return lines.map(line => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return false;
    }
    return !fence && !line.trim();
  });
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/u;

/** Maps quoted source lines of a single table block to rendered row indices. */
function quotedTableRows(
  lines: readonly string[], blockStart: number, blockEnd: number, quoteStart: number, quoteEnd: number,
): { first: number; last: number } | undefined {
  if (blockEnd - blockStart < 2 || !TABLE_SEPARATOR.test(lines[blockStart + 1]!)) return undefined;
  for (let index = blockStart; index <= blockEnd; index++) if (!lines[index]!.trimStart().startsWith("|")) return undefined;
  const row = (index: number) => index === blockStart ? 0 : Math.max(1, index - blockStart - 1);
  const first = row(Math.max(blockStart, quoteStart));
  const last = row(Math.min(blockEnd, quoteEnd));
  const total = blockEnd - blockStart; // header + body rows
  if (first === 0 && last >= total - 1) return undefined; // whole table quoted
  return { first, last };
}

/**
 * Locates a saved quotation in the current file body and returns bounded live context.
 * Saved line numbers are never trusted: a missing or repeated quotation yields no context.
 * Context is expanded to whole Markdown blocks so tables and lists render intact.
 */
export function wikiCitationContext(
  content: string,
  citation: KnowledgeCitation,
  radius = WIKI_CITATION_CONTEXT_RADIUS,
  maxLines = MAX_WIKI_CITATION_CONTEXT_LINES,
): WikiCitationContext {
  const match = matchKnowledgeCitation(content, citation.path, citation);
  if (match.status !== "matched") return { status: match.status };
  const lines = stripKnowledgeCheckStamp(content).replace(/\r\n?/gu, "\n").split("\n");
  const boundary = blockBoundaries(lines);
  const bound = Math.max(1, Math.floor(maxLines));
  const reach = Math.max(0, radius);
  const blockStart = (index: number) => { while (index > 0 && !boundary[index - 1]) index--; return index; };
  const blockEnd = (index: number) => { while (index < lines.length - 1 && !boundary[index + 1]) index++; return index; };
  const startIndex = match.range.startLine - 1;
  let quoteStart = blockStart(startIndex);
  let quoteEnd = blockEnd(match.range.endLine - 1);
  // Context is whole blocks: a block that would reach far past the radius is skipped.
  let first = Math.max(0, quoteStart - reach);
  if (first < quoteStart && !boundary[first]) {
    const whole = blockStart(first);
    if (quoteStart - whole <= reach * 2) first = whole;
    else while (first < quoteStart && !boundary[first]) first++;
  }
  let last = Math.min(lines.length - 1, quoteEnd + reach);
  if (last > quoteEnd && !boundary[last]) {
    const whole = blockEnd(last);
    if (whole - quoteEnd <= reach * 2) last = whole;
    else while (last > quoteEnd && !boundary[last]) last--;
  }
  let truncated = false;
  if (last - first + 1 > bound) { first = quoteStart; truncated = true; }
  if (last - first + 1 > bound) last = quoteEnd;
  if (last - first + 1 > bound) { quoteEnd = quoteStart + bound - 1; last = quoteEnd; }
  const tableRows = quotedTableRows(lines, quoteStart, quoteEnd, startIndex, match.range.endLine - 1);
  const join = (from: number, to: number) => lines.slice(from, to + 1).join("\n").trim();
  const heading = nearestHeading(lines, startIndex);
  return {
    status: "matched",
    before: join(first, quoteStart - 1),
    quote: join(quoteStart, quoteEnd),
    after: join(quoteEnd + 1, last),
    startLine: quoteStart + 1,
    endLine: quoteEnd + 1,
    truncated,
    ...(tableRows ? { tableRows } : {}),
    ...(heading ? { heading } : {}),
  };
}

/**
 * One-based raw-file lines of a unique quotation, for Git blame. Saved report
 * metadata is blanked with its line endings kept, so numbers match the file on disk.
 */
export function wikiCitationSourceLines(content: string, quote: string): { readonly startLine: number; readonly endLine: number } | undefined {
  const text = knowledgeEvidenceText(content).replace(/\r\n?/gu, "\n");
  const needle = quote.replace(/\r\n?/gu, "\n");
  if (!needle) return undefined;
  const start = text.indexOf(needle);
  if (start < 0 || text.indexOf(needle, start + 1) >= 0) return undefined;
  const lineAt = (offset: number) => 1 + (text.slice(0, offset).match(/\n/gu)?.length ?? 0);
  return { startLine: lineAt(start), endLine: lineAt(start + needle.length - 1) };
}
