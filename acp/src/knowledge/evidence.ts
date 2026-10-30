import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { CheckDocument, CheckEvidence } from "./comparison.js";
import { MAX_KNOWLEDGE_CHUNK_CHARS, type KnowledgeCheckCoverage, type KnowledgeReportLanguage } from "./contract.js";
import { KnowledgeReportError, reportMessage, sourceInvalid, sourceUnavailable, type KnowledgeReportMessage } from "./report-language.js";
import { knowledgeEvidenceText, MAX_KNOWLEDGE_STAMP_BYTES, MAX_KNOWLEDGE_REPORT_BYTES, stripKnowledgeCheckStamp } from "./stamp.js";

export interface KnowledgeCheckInput { cwd: string; path: string; content: string; expectedContent?: string; }
export interface KnowledgeSearchHit { kind: "code" | "knowledge"; path: string; startLine: number; endLine: number; }
export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  notices: string[];
  limitNotices?: string[];
  status: { complete: boolean; completeForSelection?: boolean; stale: boolean; semanticEnabled?: boolean; semantic?: { enabled: boolean; complete: boolean; state: string } };
}
export type KnowledgeSearch = (cwd: string, request: {
  query: string; sources: ["knowledge"]; mode: "hybrid"; pathPrefix: string;
  limit: number; includeContent: boolean; dedupeFile: boolean;
}, signal: AbortSignal) => Promise<KnowledgeSearchResult>;
export interface KnowledgeSnapshot {
  document: CheckDocument;
  evidence: CheckEvidence[];
  documentHash: string;
  wikiPath: string;
  notices: string[];
  complete: boolean;
  coverage?: KnowledgeCheckCoverage;
  /** Internal aggregation identity; never model-generated source paths. */
  candidatePaths?: readonly string[];
  excerptedPaths?: readonly string[];
  current: (signal: AbortSignal) => Promise<boolean>;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_DRAFT_CHARS = MAX_KNOWLEDGE_CHUNK_CHARS;
const MAX_QUERIES = 8;
const MAX_SOURCES = 12;
const MAX_PASSAGE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 48_000;
const MAX_INVENTORY_ENTRIES = 4096;
const CONFIG_PATH = ".pi/workspace.jsonc";
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
class SourceValidationError extends KnowledgeReportError {}
function sourceFailure(error: unknown, language: KnowledgeReportLanguage): string {
  if (error instanceof SourceValidationError) return reportMessage(language, error.reason);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return reportMessage(language, "sourceReadDenied");
  if (missing(error)) return reportMessage(language, "sourceDisappeared");
  if (code === "ELOOP") return reportMessage(language, "sourceSymlink");
  return reportMessage(language, "sourceReadUnsafe");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectPath(value: unknown): string {
  if (typeof value !== "string") throw new KnowledgeReportError("pathRequired");
  const path = value.trim().replaceAll("\\", "/");
  const parts = path.split("/");
  if (!path || isAbsolute(path) || path.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path) || parts.includes("..")) throw new KnowledgeReportError("pathUnsafe");
  const normalized = parts.filter(part => part && part !== ".").join("/");
  if (!normalized) throw new KnowledgeReportError("pathEmpty");
  return normalized;
}

function wikiPathFromConfig(source: string | undefined): string {
  let wiki: Record<string, unknown> = {};
  if (source !== undefined) {
    const errors: ParseError[] = [];
    const config: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !object(config)) throw new KnowledgeReportError("configInvalid");
    if (config.wiki !== undefined) {
      if (!object(config.wiki)) throw new KnowledgeReportError("wikiConfigInvalid");
      wiki = config.wiki;
    }
  }
  const path = projectPath(wiki.path === undefined ? "wiki" : wiki.path);
  const index = projectPath(wiki.index === undefined ? "index.md" : wiki.index);
  if (!/\.(md|markdown)$/iu.test(index)) throw new KnowledgeReportError("indexMarkdown");
  if (!durable(path) || !durable(`${path}/${index}`)) throw new KnowledgeReportError("wikiPrivate");
  return path;
}

function durable(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return !parts.some(part => part === ".git" || part === "node_modules" || part.startsWith(".env"))
    && !/^\.pi\/(artifacts|subagents)(?:\/|$)/u.test(path.toLowerCase());
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

async function directory(root: string, name: string): Promise<{ dev: number; ino: number }> {
  const path = join(root, name);
  if (!inside(root, path) || await realpath(path) !== path) throw new SourceValidationError("wikiPathSymlink");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SourceValidationError("wikiUnavailable");
  return { dev: info.dev, ino: info.ino };
}

/** Metadata-only corpus fence, including documents retrieval did not select. */
async function inventory(root: string, wikiPath: string, signal: AbortSignal): Promise<{ signature: string; complete: boolean }> {
  const pending = [wikiPath], rows: string[] = [];
  let entries = 0, complete = true;
  async function record(name: string, isDirectory: boolean): Promise<boolean> {
    signal.throwIfAborted();
    const path = join(root, name), info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())
      || !inside(root, path) || await realpath(path) !== path) return false;
    rows.push(JSON.stringify([name, isDirectory, String(info.dev), String(info.ino), String(info.size),
      String(info.mtimeNs), String(info.ctimeNs)]));
    return true;
  }
  while (pending.length && entries < MAX_INVENTORY_ENTRIES) {
    signal.throwIfAborted();
    const name = pending.pop()!;
    try {
      if (!await record(name, true)) { complete = false; continue; }
      const handle = await opendir(join(root, name));
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (++entries > MAX_INVENTORY_ENTRIES) { complete = false; break; }
        const child = `${name}/${entry.name}`;
        if (!durable(child) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name) && !await record(child, false)) complete = false;
      }
    } catch { signal.throwIfAborted(); complete = false; }
  }
  if (pending.length || entries > MAX_INVENTORY_ENTRIES) complete = false;
  rows.sort();
  return { signature: sha(JSON.stringify(rows)), complete };
}

/** Read bounded original bytes only after checking containment and regular-file identity. */
async function file(root: string, name: string, signal: AbortSignal): Promise<{ text: string; hash: string } | undefined> {
  signal.throwIfAborted();
  const path = join(root, name);
  if (!inside(root, path)) throw new SourceValidationError("sourceOutsideProject");
  let before;
  try {
    await directory(root, relative(root, dirname(path)) || ".");
    before = await lstat(path);
  } catch (error) { if (missing(error)) return undefined; throw error; }
  const markdown = /\.(md|markdown)$/iu.test(name);
  const rawLimit = MAX_FILE_BYTES + (markdown ? MAX_KNOWLEDGE_REPORT_BYTES + MAX_KNOWLEDGE_STAMP_BYTES : 0);
  if (before.size > rawLimit) throw new SourceValidationError("sourceTooLarge");
  if (!before.isFile() || before.isSymbolicLink()
    || await realpath(path) !== path) throw new SourceValidationError("sourceNotRegular");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.size > rawLimit) throw new SourceValidationError("sourceTooLarge");
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
      throw new SourceValidationError("sourceChangedOpening");
    if (await realpath(path) !== path) throw new SourceValidationError("sourcePathChanged");
    const bytes = Buffer.alloc(rawLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > rawLimit) throw new SourceValidationError("sourceTooLarge");
    const after = await lstat(path);
    if (await realpath(path) !== path || after.dev !== opened.dev || after.ino !== opened.ino)
      throw new SourceValidationError("sourceChangedReading");
    signal.throwIfAborted();
    const content = bytes.subarray(0, length);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
    catch { throw new SourceValidationError("sourceInvalidEncoding"); }
    if (text.includes("\0")) throw new SourceValidationError("sourceBinary");
    if (Buffer.byteLength(markdown ? stripKnowledgeCheckStamp(text) : text, "utf8") > MAX_FILE_BYTES) {
      throw new SourceValidationError("sourceTooLarge");
    }
    return { text, hash: sha(content) };
  } finally { await handle.close(); }
}

/** Sample evenly if necessary, so later sections are not lost behind the opening paragraph. */
function queries(text: string): { values: string[]; sampled: boolean } {
  const chunks = text.split(/\n\s*\n/u).flatMap(paragraph => {
    const compact = paragraph.replace(/\s+/gu, " ").trim();
    const pieces: string[] = [];
    for (let offset = 0; offset < compact.length; offset += 700) pieces.push(compact.slice(offset, offset + 700));
    return pieces;
  }).filter(value => /[\p{L}\p{N}]/u.test(value));
  const distinct = [...new Set(chunks)];
  if (distinct.length <= MAX_QUERIES) return { values: distinct, sampled: false };
  return { values: Array.from({ length: MAX_QUERIES }, (_, index) =>
    distinct[Math.floor(index * (distinct.length - 1) / (MAX_QUERIES - 1))]!), sampled: true };
}

interface PassageSource { text: string; lines: string[]; first: number; minimum: number; preferred: number; }
function preparePassage(text: string, hit: KnowledgeSearchHit): PassageSource {
  text = text.replaceAll("\r\n", "\n");
  const lines = text.split("\n");
  if (!Number.isInteger(hit.startLine) || !Number.isInteger(hit.endLine)
    || hit.startLine < 1 || hit.endLine < hit.startLine || hit.endLine > lines.length)
    throw new SourceValidationError("sourceRangeMismatch");
  const first = hit.startLine - 1;
  const minimum = Math.max(1, lines.slice(first, hit.endLine).join("\n").length);
  return { text, lines, first, minimum, preferred: Math.min(text.length, Math.max(MAX_PASSAGE_CHARS, minimum) + 1200) };
}

function fullLinePrefix(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const boundary = text.lastIndexOf("\n", budget);
  return boundary < 0 ? "" : text.slice(0, boundary === budget ? boundary : boundary + 1);
}

function passage(source: PassageSource, budget: number): { text: string; startLine: number; context?: string } {
  const { text, lines, first, minimum } = source;
  if (text.length <= budget) return { text, startLine: 1 };
  // The complete hit is reserved before optional lifecycle context or adjacent lines.
  const context = fullLinePrefix(text, Math.min(1200, budget - minimum));
  let textBudget = budget - context.length, start = first, available = textBudget - minimum;
  while (start > Math.max(0, first - 8)) {
    const cost = lines[start - 1]!.length + 1;
    if (cost > available) break;
    available -= cost;
    start -= 1;
  }
  if (start === 0) textBudget = budget;
  return { text: fullLinePrefix(lines.slice(start).join("\n"), textBudget), startLine: start + 1,
    ...(start > 0 && context ? { context } : {}) };
}

export async function collectKnowledgeEvidence(input: KnowledgeCheckInput, search: KnowledgeSearch, signal: AbortSignal, reportLanguage: KnowledgeReportLanguage = "en"): Promise<KnowledgeSnapshot> {
  const message = (key: KnowledgeReportMessage) => reportMessage(reportLanguage, key);
  signal.throwIfAborted();
  if (!input || typeof input.cwd !== "string" || !input.cwd.trim() || typeof input.content !== "string"
    || input.content.length > MAX_DRAFT_CHARS + MAX_KNOWLEDGE_STAMP_BYTES + MAX_KNOWLEDGE_REPORT_BYTES || input.content.includes("\0")) throw new KnowledgeReportError("documentInvalid");
  const { cwd: requestedCwd, path: requestedPath, content, expectedContent } = input;
  const draftContent = stripKnowledgeCheckStamp(content);
  if (draftContent.length > MAX_DRAFT_CHARS) throw new KnowledgeReportError("documentInvalid");
  const root = await realpath(resolve(requestedCwd));
  const rootIdentity = await directory(root, ".");
  const revisions = new Map<string, string | null>();
  async function snapshot(name: string): Promise<{ text: string; hash: string } | undefined> {
    const content = await file(root, name, signal);
    revisions.set(name, content?.hash ?? null);
    return content;
  }
  const config = await snapshot(CONFIG_PATH);
  const wikiPath = wikiPathFromConfig(config?.text);
  const wikiIdentity = await directory(root, wikiPath);
  const corpus = await inventory(root, wikiPath, signal);
  const path = projectPath(requestedPath);
  if (!path.startsWith(`${wikiPath}/`) || !/\.(md|markdown)$/iu.test(path) || !durable(path))
    throw new KnowledgeReportError("documentMarkdown");
  await directory(root, relative(root, dirname(join(root, path))));
  const baseline = await snapshot(path);
  if (expectedContent !== undefined && (baseline?.text ?? "") !== expectedContent)
    throw new KnowledgeReportError("documentChanged");
  const notices = new Set<string>();
  const limits = new Set<KnowledgeCheckCoverage["limits"][number]>();
  let complete = true;
  function incomplete(notice: string): void { complete = false; notices.add(notice); }
  if (!corpus.complete) incomplete(message("inventoryIncomplete"));
  const selection = queries(draftContent);
  if (selection.sampled) limits.add("query-sampling");
  const deadline = Date.now() + 45_000, batches: KnowledgeSearchHit[][] = [];
  for (const query of selection.values) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) { incomplete(message("retrievalTimeout")); break; }
    const querySignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    try {
      const result = await search(root, { query, sources: ["knowledge"], mode: "hybrid", pathPrefix: wikiPath,
        limit: 12, includeContent: false, dedupeFile: true }, querySignal);
      signal.throwIfAborted();
      const limitNotices = new Set(result.limitNotices ?? []);
      for (const notice of result.notices) if (!limitNotices.has(notice)) notices.add(notice);
      const completeSelection = result.status.completeForSelection === undefined
        ? result.status.complete : result.status.completeForSelection === true;
      if (!completeSelection || result.status.stale)
        incomplete(message("searchIncomplete"));
      if (limitNotices.size || (!result.status.complete && result.status.completeForSelection === true) || result.hits.length >= 12)
        limits.add("candidate-limit");
      const semantic = result.status.semantic;
      if (result.status.semanticEnabled !== true && semantic?.enabled !== true)
        incomplete(message("semanticUnavailable"));
      else if (!semantic?.enabled || !semantic.complete || semantic.state !== "ready")
        incomplete(message("semanticIncomplete"));
      batches.push(result.hits);
    } catch { signal.throwIfAborted(); incomplete(message("searchFailed")); }
    if (querySignal.aborted || Date.now() >= deadline) {
      incomplete(message("retrievalTimeout")); break;
    }
  }
  const candidates = new Map<string, KnowledgeSearchHit>();
  for (let rank = 0; rank < 12; rank++) for (const batch of batches) {
    const hit = batch[rank];
    if (!hit || hit.kind !== "knowledge") continue;
    let name: string;
    try { name = projectPath(hit.path); } catch { incomplete(message("unsafeSourceExcluded")); continue; }
    if (name === path) continue;
    if (!name.startsWith(`${wikiPath}/`)) {
      incomplete(message("outsideWikiExcluded")); continue;
    }
    if (!durable(name)) {
      incomplete(message("privateSourceExcluded")); continue;
    }
    // Knowledge search supports more formats than the Markdown Wiki comparison.
    if (!/\.(md|markdown)$/iu.test(name)) continue;
    if (!candidates.has(name)) candidates.set(name, { ...hit, path: name });
  }
  if (candidates.size > MAX_SOURCES) limits.add("source-limit");
  const evidence: CheckEvidence[] = [];
  const prepared: { hit: KnowledgeSearchHit; source: PassageSource; budget: number }[] = [];
  let remaining = MAX_CONTEXT_CHARS, excerptedSources = 0;
  const excerptedPaths: string[] = [];
  for (const hit of [...candidates.values()].slice(0, MAX_SOURCES)) {
    signal.throwIfAborted();
    try {
      const original = await snapshot(hit.path);
      if (!original) { incomplete(sourceUnavailable(reportLanguage, hit.path)); continue; }
      if (!original.text.trim()) continue;
      const source = preparePassage(knowledgeEvidenceText(original.text), hit);
      if (source.minimum > remaining) { limits.add("context-limit"); limits.add("passage-limit"); continue; }
      prepared.push({ hit, source, budget: source.minimum });
      remaining -= source.minimum;
    } catch (error) { signal.throwIfAborted(); incomplete(sourceInvalid(reportLanguage, hit.path, sourceFailure(error, reportLanguage))); }
  }
  // Reserve all matched ranges first, then share optional context across their sources.
  let growing = prepared.filter(item => item.budget < item.source.preferred);
  while (remaining && growing.length) {
    const share = Math.max(1, Math.floor(remaining / growing.length));
    for (const item of growing) {
      const extra = Math.min(remaining, share, item.source.preferred - item.budget);
      item.budget += extra; remaining -= extra;
    }
    growing = growing.filter(item => item.budget < item.source.preferred);
  }
  for (const { hit, source, budget } of prepared) {
    if (budget < source.preferred) limits.add("context-limit");
    const selected = passage(source, budget);
    if (!selected.text.trim()) continue;
    if (selected.text.length < source.text.length) { limits.add("passage-limit"); excerptedSources++; excerptedPaths.push(hit.path); }
    evidence.push({ id: `source-${evidence.length + 1}`, path: hit.path, ...selected });
  }
  if (!evidence.length) incomplete(message("noExternalSources"));
  const afterRetrieval = await inventory(root, wikiPath, signal);
  if (!afterRetrieval.complete || corpus.signature !== afterRetrieval.signature)
    incomplete(message("corpusChangedRetrieval"));
  async function current(owned: AbortSignal): Promise<boolean> {
    owned.throwIfAborted();
    try {
      if (await realpath(resolve(requestedCwd)) !== root) return false;
      const latestRoot = await directory(root, "."), latestWiki = await directory(root, wikiPath);
      if (latestRoot.dev !== rootIdentity.dev || latestRoot.ino !== rootIdentity.ino
        || latestWiki.dev !== wikiIdentity.dev || latestWiki.ino !== wikiIdentity.ino) return false;
      const latestCorpus = await inventory(root, wikiPath, owned);
      if (!corpus.complete || !latestCorpus.complete || corpus.signature !== latestCorpus.signature) return false;
      for (const [name, hash] of revisions) {
        owned.throwIfAborted();
        if (((await file(root, name, owned))?.hash ?? null) !== hash) return false;
      }
      owned.throwIfAborted();
      return true;
    } catch { owned.throwIfAborted(); return false; }
  }
  return { document: { path, text: draftContent }, evidence, documentHash: sha(draftContent), wikiPath,
    notices: [...notices], complete, current, candidatePaths: [...candidates.keys()], excerptedPaths, coverage: { scope: "retrieved-passages", checkedPassages: evidence.length,
      candidateSources: candidates.size, excerptedSources, limits: [...limits] } };
}
