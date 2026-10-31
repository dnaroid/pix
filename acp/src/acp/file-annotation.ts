import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistModelRunner, type AssistModelRunner } from "./assist-model-runner.js";
import { loadSelectionAssistConfig, type SelectionAssistConfig } from "./selection-assist.js";

/**
 * Inline commentary for Desktop Preview source files. The model receives the
 * file with line numbers and returns notes anchored to lines; Desktop renders
 * each note as a highlighted insertion above its line.
 */
export const FILE_ANNOTATION_MAX_TEXT = 120_000;
export const FILE_ANNOTATION_MAX_LINES = 3_000;
export const FILE_ANNOTATION_MAX_NOTES = 60;
const FILE_ANNOTATION_MAX_NOTE_CHARS = 600;
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
	readonly signal: AbortSignal;
}

export interface FileAnnotationResult {
	readonly annotations: readonly FileAnnotation[];
	readonly language: string;
	/** Lines the model saw; later lines were cut to fit the request. */
	readonly annotatedLines: number;
	readonly totalLines: number;
}

export type FileAnnotator = (input: FileAnnotationInput) => Promise<FileAnnotationResult>;

interface CreateFileAnnotatorOptions {
	readonly runner?: AssistModelRunner;
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadConfig?: (cwd: string) => SelectionAssistConfig;
}

export function createFileAnnotator(options: CreateFileAnnotatorOptions = {}): FileAnnotator {
	const run = options.runner ?? createAssistModelRunner(options.createModelRuntime);
	return async ({ cwd, text, path, signal }) => {
		const config = (options.loadConfig ?? loadSelectionAssistConfig)(cwd);
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
		const annotations = parseFileAnnotations(output, visible);
		if (annotations.length === 0) throw new Error("The model returned no usable annotations");
		return { annotations, language: config.language, annotatedLines: visible, totalLines: lines.length };
	};
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
Return only a JSON array, no prose and no code fences: [{"line": <line number from the listing>, "text": "<note>"}].
Write the notes in the language with this code/name: ${language}.`;
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
