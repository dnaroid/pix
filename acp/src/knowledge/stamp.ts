import { isKnowledgeCheckResult, type KnowledgeCheckResult, type KnowledgeReportLanguage } from "./contract.js";

export const KNOWLEDGE_STAMP_PREFIX = "<!-- pix:wiki-check ";
export const MAX_KNOWLEDGE_STAMP_BYTES = 4096;
export const KNOWLEDGE_REPORT_PREFIX = "<!-- pix:wiki-report ";
export const MAX_KNOWLEDGE_REPORT_BYTES = 384 * 1024;
const MAX_STAMP_SOURCES = 4096;
const MAX_MODEL_BYTES = 512;
const STAMP_KEYS = ["version", "status", "contentHash", "checkedAt", "modelRef", "scope", "checkedSources", "candidateSources", "reportLanguage"];
const encoder = new TextEncoder();

export interface KnowledgeCheckStamp {
  readonly version: 1;
  readonly status: "clear";
  readonly contentHash: string;
  readonly checkedAt: string;
  readonly modelRef: string;
  readonly scope: "retrieved-passages";
  readonly checkedSources: number;
  readonly candidateSources: number;
  readonly reportLanguage: KnowledgeReportLanguage;
}

export interface SavedKnowledgeReport {
  readonly result: KnowledgeCheckResult;
  readonly checkedAt: string;
  /** A stale report remains available as evidence, never as a verdict on the edited body. */
  readonly current: boolean;
}

interface ReportEnvelope { readonly version: 1; readonly checkedAt: string; readonly result: KnowledgeCheckResult; }
interface MetadataRange { readonly start: number; readonly end: number; }
interface ReportPrefix {
  readonly ranges: readonly MetadataRange[];
  readonly lines: readonly string[];
  readonly count: number;
  readonly present: boolean;
  readonly overflow: boolean;
}

interface StampSuffix { body: string; suffix: string; count: number; overflow: boolean; }

/** Only bounded trailing lines with the reserved opener belong to the app. */
function trailingStamps(content: string): StampSuffix {
  let body = content, count = 0, bytes = 0, overflow = false;
  while (body) {
    const end = body.endsWith("\r\n") ? body.length - 2 : body.endsWith("\n") ? body.length - 1 : body.length;
    const separator = body.lastIndexOf("\n", end - 1);
    if (separator < 0) break;
    const line = body.slice(separator + 1, end);
    if (!line.startsWith(KNOWLEDGE_STAMP_PREFIX) || line.includes("\r")) break;
    bytes += encoder.encode(body.slice(separator)).byteLength;
    if (bytes > MAX_KNOWLEDGE_STAMP_BYTES) { overflow = true; break; }
    body = body.slice(0, separator);
    count++;
  }
  return { body, suffix: content.slice(body.length), count, overflow };
}

function lineAt(content: string, start: number) {
  const newline = content.indexOf("\n", start);
  const end = newline < 0 ? content.length : newline;
  const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
  return { text: content.slice(start, textEnd), textEnd, end: newline < 0 ? content.length : newline + 1 };
}

/** Exact delimiters only; unterminated frontmatter remains ordinary body text. */
function frontmatter(content: string, start = content.startsWith("\uFEFF") ? 1 : 0) {
  const opening = lineAt(content, start);
  if ((opening.text !== "---" && opening.text !== "+++") || opening.end === content.length) return undefined;
  let cursor = opening.end;
  while (cursor < content.length) {
    const line = lineAt(content, cursor);
    if (line.text === opening.text || (opening.text === "---" && line.text === "...")) return line;
    if (line.end === content.length) break;
    cursor = line.end;
  }
  return undefined;
}

/** Bounded reserved lines at the document head or immediately after frontmatter are app-owned. */
function leadingReports(content: string): ReportPrefix {
  const ranges: MetadataRange[] = [], lines: string[] = [];
  let bytes = 0, count = 0, present = false, overflow = false;
  function group(start: number, firstComment: number): number {
    let cursor = firstComment, end = start;
    while (content.startsWith(KNOWLEDGE_REPORT_PREFIX, cursor)) {
      present = true;
      const newline = content.indexOf("\n", cursor);
      const nextEnd = newline < 0 ? content.length : newline + 1;
      if (nextEnd - end > MAX_KNOWLEDGE_REPORT_BYTES
        || (bytes += encoder.encode(content.slice(end, nextEnd)).byteLength) > MAX_KNOWLEDGE_REPORT_BYTES) {
        overflow = true;
        return nextEnd;
      }
      count++;
      lines.push(content.slice(cursor, nextEnd));
      end = nextEnd;
      cursor = end;
      if (content.startsWith("\n" + KNOWLEDGE_REPORT_PREFIX, cursor)) cursor++;
    }
    if (end > start) ranges.push({ start, end });
    return end;
  }
  const bomEnd = content.startsWith("\uFEFF") ? 1 : 0;
  let bodyStart = bomEnd;
  if (content.startsWith(KNOWLEDGE_REPORT_PREFIX, bodyStart)) bodyStart = group(bodyStart, bodyStart);
  if (!overflow) {
    const header = frontmatter(content, content[bodyStart] === "\uFEFF" ? bodyStart + 1 : bodyStart);
    if (header) {
      if (content.startsWith("\n" + KNOWLEDGE_REPORT_PREFIX, header.end)) group(header.end, header.end + 1);
      else if (content.startsWith(KNOWLEDGE_REPORT_PREFIX, header.end)) {
        // With original frontmatter-at-EOF, the inserted separator became its closing line's LF.
        // A CRLF here cannot be an app-inserted separator; keep it when stripping malformed input.
        group(content.slice(header.textEnd, header.end) === "\n" ? header.textEnd : header.end, header.end);
      }
    }
  }
  return { ranges: overflow ? [] : ranges, lines, count, present, overflow };
}

function withoutRanges(content: string, ranges: readonly MetadataRange[], preserveLines = false): string {
  let cursor = 0, output = "";
  for (const range of ranges) {
    output += content.slice(cursor, range.start);
    if (preserveLines) output += content.slice(range.start, range.end).replace(/[^\r\n]/gu, "");
    cursor = range.end;
  }
  return output + content.slice(cursor);
}

function metadata(content: string) {
  const footer = trailingStamps(content), report = leadingReports(footer.body);
  return { footer, report, body: withoutRanges(footer.body, report.ranges), overflow: footer.overflow || report.overflow };
}

/** Preserve every body byte, including its original final newline and frontmatter. */
export function stripKnowledgeCheckStamp(content: string): string {
  return metadata(content).body;
}

/** Search line references refer to the raw file, so removed metadata keeps its line endings. */
export function knowledgeEvidenceText(content: string): string {
  const { footer, report } = metadata(content);
  return withoutRanges(footer.body, report.ranges, true) + footer.suffix.replace(/[^\r\n]/gu, "");
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validStamp(value: unknown): value is KnowledgeCheckStamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stamp = value as Record<string, unknown>;
  if (Object.keys(stamp).length !== STAMP_KEYS.length || Object.keys(stamp).some(key => !STAMP_KEYS.includes(key))
    || stamp.version !== 1 || stamp.status !== "clear" || stamp.scope !== "retrieved-passages"
    || typeof stamp.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(stamp.contentHash)
    || !canonicalDate(stamp.checkedAt) || typeof stamp.modelRef !== "string" || !stamp.modelRef.trim()
    || encoder.encode(stamp.modelRef).byteLength > MAX_MODEL_BYTES || /[\u0000-\u001f\u007f]/u.test(stamp.modelRef)
    || (stamp.reportLanguage !== "en" && stamp.reportLanguage !== "ru")) return false;
  return [stamp.checkedSources, stamp.candidateSources].every(value => Number.isSafeInteger(value)
    && (value as number) >= 1 && (value as number) <= MAX_STAMP_SOURCES)
    && (stamp.candidateSources as number) >= (stamp.checkedSources as number);
}

async function contentHash(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(content));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validReport(value: unknown): value is ReportEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return Object.keys(envelope).length === 3 && Object.keys(envelope).every(key => ["version", "checkedAt", "result"].includes(key))
    && envelope.version === 1 && canonicalDate(envelope.checkedAt) && isKnowledgeCheckResult(envelope.result)
    && envelope.result.status !== "clear" && /^[0-9a-f]{64}$/u.test(envelope.result.documentHash);
}

/** Malformed/duplicate reserved blocks never yield a report; a valid stale report remains inspectable. */
export async function readKnowledgeReport(content: string): Promise<SavedKnowledgeReport | undefined> {
  const parsed = metadata(content);
  if (parsed.overflow || parsed.report.count !== 1) return undefined;
  const line = parsed.report.lines[0]!, closer = " -->\n";
  if (!line.startsWith(KNOWLEDGE_REPORT_PREFIX) || !line.endsWith(closer)) return undefined;
  const json = line.slice(KNOWLEDGE_REPORT_PREFIX.length, -closer.length);
  if (/[<>\r\n]/u.test(json)) return undefined;
  try {
    const envelope: unknown = JSON.parse(json);
    if (!validReport(envelope)) return undefined;
    return { result: envelope.result, checkedAt: envelope.checkedAt,
      current: envelope.result.documentHash === await contentHash(parsed.body) };
  } catch { return undefined; }
}

/** A saved stamp describes this body only; it is not a current verdict about other Wiki files. */
export async function readKnowledgeCheckStamp(content: string): Promise<KnowledgeCheckStamp | undefined> {
  const parsed = metadata(content);
  const { body, suffix, count, overflow } = parsed.footer;
  const opener = "\n" + KNOWLEDGE_STAMP_PREFIX, closer = " -->\n";
  if (overflow || parsed.report.present || count !== 1 || !suffix.startsWith(opener) || !suffix.endsWith(closer)) return undefined;
  const json = suffix.slice(opener.length, -closer.length);
  if (/[<>\r\n]/u.test(json)) return undefined;
  try {
    const stamp: unknown = JSON.parse(json);
    if (validStamp(stamp) && stamp.contentHash === await contentHash(body)) return stamp;
  } catch { /* Invalid metadata or unavailable hashing never becomes a successful saved check. */ }
  return undefined;
}

/** Append/replace app metadata only for a clear result that still matches the exact body. */
export async function stampKnowledgeCheck(content: string, result: KnowledgeCheckResult, checkedAt: Date | string = new Date()): Promise<string> {
  const { body, overflow } = metadata(content);
  if (overflow) throw new Error("The existing Wiki check exceeds its metadata limit.");
  if (!isKnowledgeCheckResult(result) || result.status !== "clear" || result.checkedSources < 1
    || !/^[0-9a-f]{64}$/u.test(result.documentHash) || result.documentHash !== await contentHash(body)) {
    throw new Error("The successful Wiki check does not match the current document.");
  }
  const stamp: KnowledgeCheckStamp = {
    version: 1, status: "clear", contentHash: result.documentHash,
    checkedAt: checkedAt instanceof Date ? checkedAt.toISOString() : checkedAt,
    modelRef: result.modelRef, scope: "retrieved-passages", checkedSources: result.checkedSources,
    candidateSources: result.coverage?.candidateSources ?? result.checkedSources,
    reportLanguage: result.reportLanguage ?? "en",
  };
  if (!validStamp(stamp)) throw new Error("The successful Wiki check has invalid saved-check metadata.");
  const json = JSON.stringify(stamp).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  const suffix = "\n" + KNOWLEDGE_STAMP_PREFIX + json + " -->\n";
  if (encoder.encode(suffix).byteLength > MAX_KNOWLEDGE_STAMP_BYTES) throw new Error("The saved Wiki check exceeds its metadata limit.");
  return body + suffix;
}

function attachReport(body: string, envelope: ReportEnvelope): string {
  const header = frontmatter(body), at = header?.end ?? (body.startsWith("\uFEFF") ? 1 : 0);
  const json = JSON.stringify(envelope).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  const block = (header ? "\n" : "") + KNOWLEDGE_REPORT_PREFIX + json + " -->\n";
  if (encoder.encode(block).byteLength > MAX_KNOWLEDGE_REPORT_BYTES) throw new Error("The saved Wiki report exceeds its metadata limit.");
  return body.slice(0, at) + block + body.slice(at);
}

/** Persist one complete report or one success stamp; neither metadata form participates in the body hash. */
export async function recordKnowledgeCheck(content: string, result: KnowledgeCheckResult, checkedAt: Date | string = new Date()): Promise<string> {
  if (result.status === "clear") return stampKnowledgeCheck(content, result, checkedAt);
  const { body, overflow } = metadata(content);
  if (overflow) throw new Error("The existing Wiki check exceeds its metadata limit.");
  const envelope = { version: 1 as const, checkedAt: checkedAt instanceof Date ? checkedAt.toISOString() : checkedAt, result };
  if (!validReport(envelope) || result.documentHash !== await contentHash(body)) {
    throw new Error("The Wiki report does not match the current document or has invalid metadata.");
  }
  return attachReport(body, envelope);
}

/** An unreviewed save retains prior evidence with its old hash; only a new clear check removes it. */
export async function preserveKnowledgeReport(content: string, previousContent: string): Promise<string> {
  const next = metadata(content), previous = metadata(previousContent);
  if (next.overflow || previous.overflow) throw new Error("The existing Wiki check exceeds its metadata limit.");
  const report = await readKnowledgeReport(previousContent);
  return report ? attachReport(next.body, { version: 1, checkedAt: report.checkedAt, result: report.result }) : next.body;
}
