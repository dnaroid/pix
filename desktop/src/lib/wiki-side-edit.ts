import { KNOWLEDGE_REPORT_PREFIX, preserveKnowledgeReport, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";

/** Body lines of a quoted block as shown in the comparison; `text` joins them with "\n". */
export interface WikiEditableBlock {
  /** One-based lines of the page body without saved report metadata. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface LineSpan { readonly start: number; readonly end: number; readonly eol: string }

function lineSpans(body: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (const match of body.matchAll(/\r\n|\r|\n/gu)) {
    spans.push({ start, end: match.index, eol: match[0] });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: body.length, eol: "" });
  return spans;
}

/** Raw text of body lines `startLine..endLine`, or undefined when the range is outside the body. */
export function wikiEditableBlock(content: string, startLine: number, endLine: number): WikiEditableBlock | undefined {
  const body = stripKnowledgeCheckStamp(content);
  const spans = lineSpans(body);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > spans.length) {
    return undefined;
  }
  const text = spans.slice(startLine - 1, endLine).map(span => body.slice(span.start, span.end)).join("\n");
  return { startLine, endLine, text };
}

/**
 * Replaces exactly the edited block in the raw file. Returns undefined when the
 * block no longer has the text the user started from. Other bytes keep their
 * line endings; a saved report is preserved with its old hash, so it reads as
 * stale until the page is rechecked (the same rule as an unreviewed Preview save).
 */
export async function applyWikiSideEdit(content: string, block: WikiEditableBlock, replacement: string): Promise<string | undefined> {
  const current = wikiEditableBlock(content, block.startLine, block.endLine);
  if (current?.text !== block.text) return undefined;
  const normalized = replacement.replace(/\r\n?/gu, "\n");
  if (normalized === block.text) return content;
  const body = stripKnowledgeCheckStamp(content);
  const spans = lineSpans(body);
  const first = spans[block.startLine - 1]!, last = spans[block.endLine - 1]!;
  const eol = first.eol || /\r\n|\r|\n/u.exec(body)?.[0] || "\n";
  const next = body.slice(0, first.start) + normalized.split("\n").join(eol) + body.slice(last.end);
  return content.includes(KNOWLEDGE_REPORT_PREFIX) ? preserveKnowledgeReport(next, content) : next;
}
