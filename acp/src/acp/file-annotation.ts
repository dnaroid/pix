import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistModelRunner, type AssistModelRunner } from "./assist-model-runner.js";
import { createProjectJsonCache, type ProjectJsonCache } from "./project-json-cache.js";
import { loadSelectionAssistConfig, type SelectionAssistConfig } from "./selection-assist.js";

/**
 * Inline commentary for Desktop Preview source files ("Explain"). The model
 * receives the file with line numbers and returns a module summary plus notes
 * anchored to lines; Desktop renders the summary above the first line and
 * each note as a highlighted insertion above its line.
 *
 * Results are cached per project in `.pi/explanations/`, one entry per file
 * path. An entry is valid only for the exact source text (SHA-256) and target
 * language it was produced from; any edit invalidates it — the stale entry is
 * deleted on lookup and replaced by the next result.
 */
export const EXPLANATION_CACHE_DIRECTORY = ".pi/explanations";
const EXPLANATION_CACHE_VERSION = 1;
export const FILE_ANNOTATION_MAX_TEXT = 120_000;
export const FILE_ANNOTATION_MAX_LINES = 3_000;
export const FILE_ANNOTATION_MAX_NOTES = 60;
const FILE_ANNOTATION_MAX_NOTE_CHARS = 600;
const FILE_ANNOTATION_MAX_SUMMARY_CHARS = 1_500;
const FILE_ANNOTATION_MAX_TOKENS = 6_000;
const FILE_ANNOTATION_TIMEOUT_MS = 120_000;

export interface FileAnnotation {
	/** 1-based source line the note is shown above. */
	readonly line: number;
	readonly text: string;
}

export interface FileAnnotationInput {
	readonly cwd: string;
	readonly text: string;
	readonly path?: string;
	/** Skip the cache and explain again (the result replaces the cached one). */
	readonly refresh?: boolean;
	readonly signal: AbortSignal;
}

export interface FileAnnotationResult {
	/** What the module does, shown before the first line. */
	readonly summary: string;
	readonly annotations: readonly FileAnnotation[];
	readonly language: string;
	/** Lines the model saw; later lines were cut to fit the request. */
	readonly annotatedLines: number;
	readonly totalLines: number;
	readonly cached: boolean;
}

export type FileAnnotator = (input: FileAnnotationInput) => Promise<FileAnnotationResult>;

interface CreateFileAnnotatorOptions {
	readonly runner?: AssistModelRunner;
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadConfig?: (cwd: string) => SelectionAssistConfig;
	readonly cache?: ProjectJsonCache;
	/** Cache failures never fail an explanation; they are reported here. */
	readonly onCacheError?: (error: unknown) => void;
}

interface ExplanationCacheEntry {
	readonly version: number;
	readonly path: string;
	readonly contentHash: string;
	readonly language: string;
	readonly createdAt: string;
	readonly result: Omit<FileAnnotationResult, "cached">;
}

export function createFileAnnotator(options: CreateFileAnnotatorOptions = {}): FileAnnotator {
	const run = options.runner ?? createAssistModelRunner(options.createModelRuntime);
	const cache = options.cache ?? createProjectJsonCache({ directory: EXPLANATION_CACHE_DIRECTORY });
	const reportCacheError = options.onCacheError ?? (() => {});
	return async ({ cwd, text, path, refresh = false, signal }) => {
		const config = (options.loadConfig ?? loadSelectionAssistConfig)(cwd);
		const key = explanationCacheKey(path ?? "", text);
		const contentHash = sourceHash(text);
		if (!refresh) {
			const entry = await cache.read(cwd, key).catch((error: unknown) => { reportCacheError(error); return undefined; });
			if (isCacheEntry(entry) && entry.contentHash === contentHash && entry.language === config.language && entry.path === (path ?? "")) {
				return { ...entry.result, cached: true };
			}
			// Source or language changed: drop the stale explanation now.
			if (entry !== undefined) await cache.remove(cwd, key).catch(reportCacheError);
		}
		if (config.modelRefs.length === 0) throw new Error("No annotation model is configured");
		const lines = text.replace(/\r\n?/gu, "\n").split("\n");
		const visible = visibleLineCount(lines);
		const output = await run({
			modelRefs: config.modelRefs,
			systemPrompt: annotateSystemPrompt(config.language),
			prompt: buildAnnotatePrompt(lines.slice(0, visible), path, visible < lines.length),
			maxTokens: FILE_ANNOTATION_MAX_TOKENS,
			timeoutMs: FILE_ANNOTATION_TIMEOUT_MS,
			signal,
		});
		signal.throwIfAborted();
		const { summary, annotations } = parseFileExplanation(output, visible);
		if (!summary && annotations.length === 0) throw new Error("The model returned no usable explanation");
		const result = { summary, annotations, language: config.language, annotatedLines: visible, totalLines: lines.length };
		const entry: ExplanationCacheEntry = {
			version: EXPLANATION_CACHE_VERSION, path: path ?? "", contentHash, language: config.language, createdAt: new Date().toISOString(), result,
		};
		await cache.write(cwd, key, entry).catch(reportCacheError);
		void cache.prune(cwd).catch(reportCacheError);
		return { ...result, cached: false };
	};
}

/** One entry per file path; files without a path are keyed by content. */
export function explanationCacheKey(path: string, text: string): string {
	return createHash("sha256").update(JSON.stringify([EXPLANATION_CACHE_VERSION, path || `content:${sourceHash(text)}`])).digest("hex");
}

function sourceHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isCacheEntry(value: unknown): value is ExplanationCacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	const result = entry.result as Record<string, unknown> | undefined;
	return entry.version === EXPLANATION_CACHE_VERSION
		&& typeof entry.path === "string" && typeof entry.contentHash === "string" && typeof entry.language === "string"
		&& typeof result === "object" && result !== null
		&& typeof result.summary === "string" && Array.isArray(result.annotations)
		&& typeof result.annotatedLines === "number" && typeof result.totalLines === "number";
}

/**
 * Accepts `{ "summary": "...", "notes": [...] }` (optionally fenced or
 * wrapped in prose) or a bare notes array.
 */
export function parseFileExplanation(output: string, lineCount: number): { summary: string; annotations: FileAnnotation[] } {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	const arrayStart = output.indexOf("[");
	if (start >= 0 && end > start && (arrayStart < 0 || start < arrayStart)) {
		try {
			const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const record = parsed as Record<string, unknown>;
				const summary = typeof record.summary === "string"
					? record.summary.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim().slice(0, FILE_ANNOTATION_MAX_SUMMARY_CHARS)
					: "";
				const notes = Array.isArray(record.notes) ? record.notes : Array.isArray(record.annotations) ? record.annotations : [];
				return { summary, annotations: parseFileAnnotations(JSON.stringify(notes), lineCount) };
			}
		} catch {
			// Fall back to a bare array below.
		}
	}
	return { summary: "", annotations: parseFileAnnotations(output, lineCount) };
}

function visibleLineCount(lines: readonly string[]): number {
	let chars = 0;
	for (let index = 0; index < lines.length && index < FILE_ANNOTATION_MAX_LINES; index += 1) {
		chars += lines[index]!.length + 1;
		if (chars > FILE_ANNOTATION_MAX_TEXT) return Math.max(1, index);
	}
	return Math.min(lines.length, FILE_ANNOTATION_MAX_LINES);
}

/**
 * Accepts a JSON array (optionally fenced or surrounded by prose) of
 * `{ line, text }` objects; drops invalid items, clamps to known lines and
 * merges notes that target the same line.
 */
export function parseFileAnnotations(output: string, lineCount: number): FileAnnotation[] {
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const byLine = new Map<number, string[]>();
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const line = typeof record.line === "number" ? record.line : typeof record.line === "string" ? Number(record.line) : Number.NaN;
		const note = typeof record.text === "string" ? record.text : typeof record.note === "string" ? record.note : "";
		const cleaned = note.replace(/\s+/gu, " ").trim().slice(0, FILE_ANNOTATION_MAX_NOTE_CHARS);
		if (!Number.isInteger(line) || line < 1 || line > lineCount || !cleaned) continue;
		byLine.set(line, [...(byLine.get(line) ?? []), cleaned]);
	}
	return [...byLine.entries()]
		.sort(([left], [right]) => left - right)
		.slice(0, FILE_ANNOTATION_MAX_NOTES)
		.map(([line, notes]) => ({ line, text: notes.join(" ") }));
}

function annotateSystemPrompt(language: string): string {
	return `You annotate a source file for a developer reading it in a code viewer. Your notes are shown as highlighted inline insertions directly above the line they target.
Write notes like insightful code-review comments: what a block does and why, non-obvious behaviour, invariants, side effects, edge cases and error handling. Never restate a line literally and skip trivial code (imports, braces, obvious assignments).
Anchor each note to the first line of the block it explains: the start of a function, class, important statement or branch. Use roughly one note per meaningful block, at most ${FILE_ANNOTATION_MAX_NOTES} notes, each one or two short sentences. Wrap identifiers in backticks.
Also write a module summary shown above the first line: two to four sentences on what the file is for, its main responsibilities and how it fits into the project.
Return only a JSON object, no prose and no code fences: {"summary": "<module summary>", "notes": [{"line": <line number from the listing>, "text": "<note>"}]}.
Write the summary and notes in the language with this code/name: ${language}.`;
}

function buildAnnotatePrompt(lines: readonly string[], path: string | undefined, truncated: boolean): string {
	const width = String(lines.length).length;
	return [
		...(path ? [`File: ${path}`] : []),
		...(truncated ? ["(Only the beginning of the file is listed.)"] : []),
		"<file>",
		...lines.map((line, index) => `${String(index + 1).padStart(width, " ")}| ${line}`),
		"</file>",
	].join("\n");
}
