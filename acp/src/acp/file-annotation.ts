import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistModelRunner, type AssistModelRunner } from "./assist-model-runner.js";
import { parseFileExplanation, type FileAnnotation } from "./file-explanation-parser.js";
import { createProjectJsonCache, type ProjectJsonCache } from "./project-json-cache.js";
import { loadSelectionAssistConfig, type SelectionAssistConfig } from "./selection-assist.js";

export type { FileAnnotation } from "./file-explanation-parser.js";

/**
 * Inline commentary for Desktop Preview source files ("Explain"). Desktop
 * renders the module summary above the first line and each note as a
 * highlighted insertion above its line.
 *
 * A small file is one model call returning `{ summary, notes }`. A larger one
 * is split at top-level boundaries into parts of about 300–450 lines that are
 * explained concurrently (at most `FILE_ANNOTATION_CONCURRENCY` at once), with
 * the module summary requested in parallel; progress is reported per part.
 *
 * Caching in `.pi/explanations/`:
 * - the whole result, one entry per file path, valid only for the exact source
 *   SHA-256 and language (a mismatch deletes it on lookup);
 * - each part, keyed by language and its exact text with notes stored relative
 *   to the part, so after an edit only changed parts go to a model, even when
 *   lines above them moved.
 * Retention is shared with other project caches (30 days unused, 4,000 entries).
 */
export const EXPLANATION_CACHE_DIRECTORY = ".pi/explanations";
const EXPLANATION_CACHE_VERSION = 2;
export const FILE_ANNOTATION_MAX_TEXT = 400_000;
export const FILE_ANNOTATION_MAX_LINES = 8_000;
/** A part ends at a top-level boundary after this many lines… */
export const FILE_ANNOTATION_PART_TARGET_LINES = 300;
/** …and is cut regardless at this many lines or characters. */
export const FILE_ANNOTATION_PART_MAX_LINES = 450;
const PART_MAX_CHARS = 18_000;
export const FILE_ANNOTATION_CONCURRENCY = 3;
const NOTES_PER_PART = 15;
const SINGLE_MAX_NOTES = 20;
const MAX_TOTAL_NOTES = 400;
/** Cyrillic notes cost about twice the tokens; a cut-off answer still keeps its closed notes. */
const PART_MAX_TOKENS = 4_096;
const PART_TIMEOUT_MS = 90_000;
const SUMMARY_MAX_TOKENS = 1_024;
const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_SOURCE_CHARS = 60_000;

export interface FileAnnotationProgress {
	/** Set once, when the module summary is ready. */
	readonly summary?: string;
	/** Notes of the part that just finished (absolute line numbers). */
	readonly annotations?: readonly FileAnnotation[];
	readonly completedParts: number;
	readonly totalParts: number;
}

export interface FileAnnotationInput {
	readonly cwd: string;
	readonly text: string;
	readonly path?: string;
	/** Skip every cache and explain again (results replace cached ones). */
	readonly refresh?: boolean;
	readonly signal: AbortSignal;
	readonly onProgress?: (progress: FileAnnotationProgress) => Promise<void> | void;
}

export interface FileAnnotationResult {
	/** What the module does, shown before the first line. */
	readonly summary: string;
	readonly annotations: readonly FileAnnotation[];
	readonly language: string;
	/** Lines the model saw; later lines were cut to fit the request. */
	readonly annotatedLines: number;
	readonly totalLines: number;
	readonly parts: number;
	/** Parts whose request failed; the result is partial and not cached as a whole. */
	readonly failedParts: number;
	readonly cached: boolean;
}

export type FileAnnotator = (input: FileAnnotationInput) => Promise<FileAnnotationResult>;

interface CreateFileAnnotatorOptions {
	readonly runner?: AssistModelRunner;
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadConfig?: (cwd: string) => SelectionAssistConfig;
	readonly cache?: ProjectJsonCache;
	readonly concurrency?: number;
	/** Cache failures never fail an explanation; they are reported here. */
	readonly onCacheError?: (error: unknown) => void;
	/** An answer that yielded nothing usable, for diagnostics (bounded excerpt). */
	readonly onUnusableAnswer?: (excerpt: string) => void;
}

interface FileCacheEntry {
	readonly version: number;
	readonly kind: "file";
	readonly path: string;
	readonly contentHash: string;
	readonly language: string;
	readonly createdAt: string;
	readonly result: Omit<FileAnnotationResult, "cached">;
}

interface PartCacheEntry {
	readonly version: number;
	readonly kind: "part";
	readonly language: string;
	readonly createdAt: string;
	/** Line numbers relative to the part (1 = its first line). */
	readonly notes: readonly FileAnnotation[];
}

export interface FilePart {
	/** 1-based first and last source line. */
	readonly firstLine: number;
	readonly lastLine: number;
	readonly lines: readonly string[];
}

export function createFileAnnotator(options: CreateFileAnnotatorOptions = {}): FileAnnotator {
	const run = options.runner ?? createAssistModelRunner(options.createModelRuntime);
	const cache = options.cache ?? createProjectJsonCache({ directory: EXPLANATION_CACHE_DIRECTORY });
	const reportCacheError = options.onCacheError ?? (() => {});
	const concurrency = Math.max(1, options.concurrency ?? FILE_ANNOTATION_CONCURRENCY);
	const readCache = (cwd: string, key: string) => cache.read(cwd, key).catch((error: unknown) => { reportCacheError(error); return undefined; });
	const writeCache = (cwd: string, key: string, value: unknown) => cache.write(cwd, key, value).catch(reportCacheError);

	return async ({ cwd, text, path = "", refresh = false, signal, onProgress }) => {
		const config = (options.loadConfig ?? loadSelectionAssistConfig)(cwd);
		const fileKey = fileCacheKey(path, text);
		const contentHash = sha256(text);
		if (!refresh) {
			const entry = await readCache(cwd, fileKey);
			if (isFileEntry(entry) && entry.contentHash === contentHash && entry.language === config.language && entry.path === path) {
				return { ...entry.result, cached: true };
			}
			// Source or language changed: drop the stale explanation now.
			if (entry !== undefined) await cache.remove(cwd, fileKey).catch(reportCacheError);
		}
		if (config.modelRefs.length === 0) throw new Error("No annotation model is configured");

		const allLines = text.replace(/\r\n?/gu, "\n").split("\n");
		const visible = visibleLineCount(allLines);
		const lines = allLines.slice(0, visible);
		const truncated = visible < allLines.length;
		const parts = splitFileIntoParts(lines);
		const ask = (systemPrompt: string, prompt: string, maxTokens: number, timeoutMs: number) =>
			run({ modelRefs: config.modelRefs, systemPrompt, prompt, maxTokens, timeoutMs, signal });
		const unusable = (output: string) => {
			options.onUnusableAnswer?.(output.slice(0, 600));
			return new Error(output.trim() ? "The model's answer could not be read as an explanation." : "The model returned an empty answer.");
		};

		let summary = "";
		let annotations: FileAnnotation[] = [];
		let failedParts = 0;
		if (parts.length === 1) {
			const output = await ask(singleSystemPrompt(config.language), numberedListing(parts[0]!, path, truncated), PART_MAX_TOKENS * 2, PART_TIMEOUT_MS);
			signal.throwIfAborted();
			const parsed = parseFileExplanation(output, { firstLine: 1, lastLine: visible, maxNotes: SINGLE_MAX_NOTES });
			if (!parsed.summary && parsed.annotations.length === 0) throw unusable(output);
			({ summary, annotations } = parsed);
			await onProgress?.({ summary, annotations, completedParts: 1, totalParts: 1 });
		} else {
			let completed = 0;
			let progress = Promise.resolve();
			// Progress callbacks are serialized so the client sees parts in completion order.
			const report = (update: Omit<FileAnnotationProgress, "completedParts" | "totalParts">, done: boolean) => {
				if (done) completed += 1;
				const snapshot = { ...update, completedParts: completed, totalParts: parts.length };
				progress = progress.then(() => onProgress?.(snapshot));
				return progress;
			};
			const summaryTask = ask(summarySystemPrompt(config.language), summaryPrompt(lines, path, truncated), SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS)
				.then(async (output) => {
					const value = cleanSummaryText(output);
					if (value) await report({ summary: value }, false);
					return value;
				});
			const partTask = mapWithConcurrency(parts, concurrency, async (part) => {
				const partKey = partCacheKey(config.language, part.lines);
				if (!refresh) {
					const entry = await readCache(cwd, partKey);
					if (isPartEntry(entry) && entry.language === config.language) {
						const notes = rebase(entry.notes, part);
						await report({ annotations: notes }, true);
						return notes;
					}
				}
				const output = await ask(partSystemPrompt(config.language), partPrompt(part, path, visible), PART_MAX_TOKENS, PART_TIMEOUT_MS);
				signal.throwIfAborted();
				const parsed = parseFileExplanation(output, { firstLine: part.firstLine, lastLine: part.lastLine, maxNotes: NOTES_PER_PART });
				if (parsed.annotations.length === 0 && !/"notes"\s*:\s*\[\s*\]/u.test(output)) throw unusable(output);
				const entry: PartCacheEntry = {
					version: EXPLANATION_CACHE_VERSION, kind: "part", language: config.language, createdAt: new Date().toISOString(),
					notes: parsed.annotations.map((note) => ({ line: note.line - part.firstLine + 1, text: note.text })),
				};
				await writeCache(cwd, partKey, entry);
				await report({ annotations: parsed.annotations }, true);
				return parsed.annotations;
			});
			const [summaryResult, partResults] = await Promise.all([settle(summaryTask), partTask]);
			await progress;
			signal.throwIfAborted();
			summary = summaryResult.status === "fulfilled" ? summaryResult.value : "";
			const failures = partResults.filter((result) => result.status === "rejected");
			failedParts = failures.length;
			annotations = partResults.flatMap((result) => result.status === "fulfilled" ? result.value : [])
				.sort((left, right) => left.line - right.line)
				.slice(0, MAX_TOTAL_NOTES);
			if (!summary && annotations.length === 0) {
				const reason = failures[0]?.status === "rejected" ? failures[0].reason : summaryResult.status === "rejected" ? summaryResult.reason : undefined;
				throw reason instanceof Error ? reason : new Error("The model returned no usable explanation.");
			}
		}

		const result = { summary, annotations, language: config.language, annotatedLines: visible, totalLines: allLines.length, parts: parts.length, failedParts };
		if (failedParts === 0 && summary) {
			const entry: FileCacheEntry = {
				version: EXPLANATION_CACHE_VERSION, kind: "file", path, contentHash, language: config.language, createdAt: new Date().toISOString(), result,
			};
			await writeCache(cwd, fileKey, entry);
		}
		void cache.prune(cwd).catch(reportCacheError);
		return { ...result, cached: false };
	};
}

/**
 * Split at top-level boundaries: after the target size, a part ends before a
 * non-indented line that follows a blank line or a closing bracket; it is cut
 * regardless at the line or character limit.
 */
export function splitFileIntoParts(lines: readonly string[]): FilePart[] {
	const parts: FilePart[] = [];
	let start = 0;
	let chars = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const size = index - start;
		const line = lines[index]!;
		const previous = index > 0 ? lines[index - 1]! : "";
		const boundary = size >= FILE_ANNOTATION_PART_TARGET_LINES && /^\S/u.test(line) && (!previous.trim() || /^[}\])]/u.test(previous));
		if (size > 0 && (boundary || size >= FILE_ANNOTATION_PART_MAX_LINES || chars + line.length + 1 > PART_MAX_CHARS)) {
			parts.push({ firstLine: start + 1, lastLine: index, lines: lines.slice(start, index) });
			start = index;
			chars = 0;
		}
		chars += line.length + 1;
	}
	parts.push({ firstLine: start + 1, lastLine: Math.max(start + 1, lines.length), lines: lines.slice(start) });
	// A tiny tail reads better merged into the previous part.
	if (parts.length > 1 && parts.at(-1)!.lines.length < 40) {
		const tail = parts.pop()!;
		const previous = parts.pop()!;
		parts.push({ firstLine: previous.firstLine, lastLine: tail.lastLine, lines: [...previous.lines, ...tail.lines] });
	}
	return parts;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await settle(map(items[index]!));
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
}

function rebase(notes: readonly FileAnnotation[], part: FilePart): FileAnnotation[] {
	return notes
		.map((note) => ({ line: note.line + part.firstLine - 1, text: note.text }))
		.filter((note) => note.line >= part.firstLine && note.line <= part.lastLine);
}

/** One whole-result entry per file path; files without a path are keyed by content. */
export function explanationCacheKey(path: string, text: string): string {
	return fileCacheKey(path, text);
}

function fileCacheKey(path: string, text: string): string {
	return sha256(JSON.stringify([EXPLANATION_CACHE_VERSION, "file", path || `content:${sha256(text)}`]));
}

function partCacheKey(language: string, lines: readonly string[]): string {
	return sha256(JSON.stringify([EXPLANATION_CACHE_VERSION, "part", language, lines.join("\n")]));
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isFileEntry(value: unknown): value is FileCacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	const result = entry.result as Record<string, unknown> | undefined;
	return entry.version === EXPLANATION_CACHE_VERSION && entry.kind === "file"
		&& typeof entry.path === "string" && typeof entry.contentHash === "string" && typeof entry.language === "string"
		&& typeof result === "object" && result !== null
		&& typeof result.summary === "string" && Array.isArray(result.annotations)
		&& typeof result.annotatedLines === "number" && typeof result.totalLines === "number";
}

function isPartEntry(value: unknown): value is PartCacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.version === EXPLANATION_CACHE_VERSION && entry.kind === "part" && typeof entry.language === "string"
		&& Array.isArray(entry.notes)
		&& entry.notes.every((note) => typeof note === "object" && note !== null
			&& Number.isInteger((note as FileAnnotation).line) && typeof (note as FileAnnotation).text === "string");
}

function visibleLineCount(lines: readonly string[]): number {
	let chars = 0;
	for (let index = 0; index < lines.length && index < FILE_ANNOTATION_MAX_LINES; index += 1) {
		chars += lines[index]!.length + 1;
		if (chars > FILE_ANNOTATION_MAX_TEXT) return Math.max(1, index);
	}
	return Math.min(lines.length, FILE_ANNOTATION_MAX_LINES);
}

function cleanSummaryText(output: string): string {
	return output.replace(/^```\w*\n?|\n?```$/gu, "").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim().slice(0, 1_500);
}

const NOTE_STYLE = `Write notes like insightful code-review comments: what a block does and why, non-obvious behaviour, invariants, side effects, edge cases and error handling. Never restate a line literally and skip trivial code (imports, braces, obvious assignments).
Anchor each note to the first line of the block it explains: the start of a function, class, important statement or branch. Use roughly one note per meaningful block, each one or two short sentences (under 30 words). Wrap identifiers in backticks.`;
const JSON_RULES = `Escape quotes and newlines inside strings as JSON requires. No prose and no code fences.`;

function singleSystemPrompt(language: string): string {
	return `You annotate a source file for a developer reading it in a code viewer. Your notes are shown as highlighted inline insertions directly above the line they target.
${NOTE_STYLE} At most ${SINGLE_MAX_NOTES} notes.
Also write a module summary shown above the first line: two to four sentences on what the file is for, its main responsibilities and how it fits into the project.
Return only a JSON object: {"summary": "<module summary>", "notes": [{"line": <line number from the listing>, "text": "<note>"}]}. Write "summary" first, then notes in line order. ${JSON_RULES}
Write the summary and notes in the language with this code/name: ${language}.`;
}

function partSystemPrompt(language: string): string {
	return `You annotate one part of a larger source file for a developer reading it in a code viewer. Your notes are shown as highlighted inline insertions directly above the line they target.
${NOTE_STYLE} At most ${NOTES_PER_PART} notes for this part; only reference line numbers shown in the listing.
Return only a JSON object: {"notes": [{"line": <line number from the listing>, "text": "<note>"}]}, notes in line order; use {"notes": []} if nothing deserves a note. ${JSON_RULES}
Write the notes in the language with this code/name: ${language}.`;
}

function summarySystemPrompt(language: string): string {
	return `You summarize a source file for a developer opening it in a code viewer. Write two to four sentences on what the file is for, its main responsibilities and how it fits into the project. Wrap identifiers in backticks.
Output only the summary text: no heading, no list, no code fences.
Write in the language with this code/name: ${language}.`;
}

function numberedListing(part: FilePart, path: string, truncated: boolean): string {
	const width = String(part.lastLine).length;
	return [
		...(path ? [`File: ${path}`] : []),
		...(truncated ? ["(Only the beginning of the file is listed.)"] : []),
		"<file>",
		...part.lines.map((line, index) => `${String(part.firstLine + index).padStart(width, " ")}| ${line}`),
		"</file>",
	].join("\n");
}

function partPrompt(part: FilePart, path: string, totalLines: number): string {
	const width = String(part.lastLine).length;
	return [
		...(path ? [`File: ${path}`] : []),
		`Part: lines ${part.firstLine}–${part.lastLine} of ${totalLines}`,
		"<part>",
		...part.lines.map((line, index) => `${String(part.firstLine + index).padStart(width, " ")}| ${line}`),
		"</part>",
	].join("\n");
}

function summaryPrompt(lines: readonly string[], path: string, truncated: boolean): string {
	let source = lines.join("\n");
	const cut = truncated || source.length > SUMMARY_SOURCE_CHARS;
	if (source.length > SUMMARY_SOURCE_CHARS) source = source.slice(0, SUMMARY_SOURCE_CHARS);
	return [...(path ? [`File: ${path}`] : []), ...(cut ? ["(Only the beginning of the file is shown.)"] : []), "<file>", source, "</file>"].join("\n");
}
