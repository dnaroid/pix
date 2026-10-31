import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistModelRunner, type AssistDelta, type AssistModelRunner } from "./assist-model-runner.js";
import { loadSelectionAssistConfig, type SelectionAssistConfig } from "./selection-assist.js";
import { createTranslationCache, type TranslationCache } from "./translation-cache.js";

/**
 * Whole-document Markdown translation for Desktop Preview. The document is
 * split into Markdown-aware chunks that are translated sequentially; fenced
 * code and front matter pass through untouched, and every translated chunk is
 * stored in the project translation cache so a repeated translation only
 * sends new or changed chunks to a model.
 */
export const DOCUMENT_TRANSLATION_MAX_CHARS = 400_000;
export const DOCUMENT_TRANSLATION_CHUNK_CHARS = 4_000;
const CHUNK_MAX_TOKENS = 8_192;
const CHUNK_TIMEOUT_MS = 120_000;
const PIECE_SEPARATOR = "\n\n";

export interface DocumentPiece {
	readonly text: string;
	/** False for fenced code and front matter, which are kept verbatim. */
	readonly translate: boolean;
}

export interface DocumentTranslationInput {
	readonly cwd: string;
	readonly text: string;
	readonly path?: string;
	/** Ignore cached chunks and translate everything again (results still refresh the cache). */
	readonly refresh?: boolean;
	readonly signal: AbortSignal;
	/** Progressive output of the whole translated document; `reset` restarts it. */
	readonly onDelta?: (delta: AssistDelta) => Promise<void> | void;
}

export interface DocumentTranslationResult {
	readonly text: string;
	readonly language: string;
	readonly chunks: number;
	readonly cachedChunks: number;
}

export type DocumentTranslator = (input: DocumentTranslationInput) => Promise<DocumentTranslationResult>;

interface CreateDocumentTranslatorOptions {
	readonly runner?: AssistModelRunner;
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadConfig?: (cwd: string) => SelectionAssistConfig;
	readonly cache?: TranslationCache;
	/** Cache read/write failures never fail a translation; they are reported here. */
	readonly onCacheError?: (error: unknown) => void;
}

export function createDocumentTranslator(options: CreateDocumentTranslatorOptions = {}): DocumentTranslator {
	const run = options.runner ?? createAssistModelRunner(options.createModelRuntime);
	const cache = options.cache ?? createTranslationCache();
	const reportCacheError = options.onCacheError ?? (() => {});

	return async ({ cwd, text, path, refresh = false, signal, onDelta }) => {
		const config = (options.loadConfig ?? loadSelectionAssistConfig)(cwd);
		const pieces = splitMarkdownForTranslation(text);
		const translatable = pieces.filter((piece) => piece.translate).length;
		if (translatable > 0 && config.modelRefs.length === 0) throw new Error("No translation model is configured");
		const output = createProgressiveOutput(onDelta);
		let done = "";
		let cachedChunks = 0;
		try {
			for (const piece of pieces) {
				signal.throwIfAborted();
				const prefix = done ? PIECE_SEPARATOR : "";
				let translated: string | undefined;
				if (!piece.translate) translated = piece.text;
				else if (!refresh) {
					translated = await cache.get(cwd, config.language, piece.text).catch((error: unknown) => { reportCacheError(error); return undefined; });
					if (translated !== undefined) cachedChunks += 1;
				}
				if (translated === undefined) {
					await output.beginChunk(done, done + prefix);
					translated = await run({
						modelRefs: config.modelRefs,
						systemPrompt: documentTranslateSystemPrompt(config.language),
						prompt: buildDocumentChunkPrompt(piece.text, path),
						maxTokens: CHUNK_MAX_TOKENS,
						timeoutMs: CHUNK_TIMEOUT_MS,
						signal,
						onDelta: async (delta) => {
							if ("reset" in delta) await output.beginChunk(done, done + prefix);
							else await output.append(delta.text);
						},
					});
					signal.throwIfAborted();
					await cache.set(cwd, config.language, piece.text, translated).catch(reportCacheError);
				}
				done += prefix + translated;
				await output.sync(done);
			}
		} finally {
			void cache.prune(cwd).catch(reportCacheError);
		}
		return { text: done, language: config.language, chunks: translatable, cachedChunks };
	};
}

/**
 * Mirrors the client's view of the translated text. Streamed chunk tokens are
 * appended after `base` (completed text plus separator); whitespace at the
 * chunk edges is held back so the final trimmed chunk normally extends the
 * streamed text without a reset.
 */
function createProgressiveOutput(onDelta: DocumentTranslationInput["onDelta"]) {
	let emitted = "";
	let base = "";
	let pending = "";
	let started = false;
	const emit = async (text: string) => {
		if (!text) return;
		emitted += text;
		for (const slice of deltaSlices(text)) await onDelta?.({ text: slice });
	};
	const sync = async (target: string): Promise<void> => {
		if (target === emitted) return;
		if (target.startsWith(emitted)) { await emit(target.slice(emitted.length)); return; }
		emitted = "";
		await onDelta?.({ reset: true });
		await emit(target);
	};
	return {
		sync,
		/** Start streaming a chunk after `done`; `chunkBase` is `done` plus its separator. */
		async beginChunk(done: string, chunkBase: string): Promise<void> {
			await sync(done);
			base = chunkBase;
			pending = "";
			started = false;
		},
		async append(delta: string): Promise<void> {
			let text = pending + delta;
			if (!started) text = text.trimStart();
			const trimmed = text.trimEnd();
			pending = text.slice(trimmed.length);
			if (!trimmed) return;
			if (!started) {
				started = true;
				if (base.startsWith(emitted)) await emit(base.slice(emitted.length));
				else await sync(base);
			}
			await emit(trimmed);
		},
	};
}

/** Desktop accepts bounded delta notifications; never split a surrogate pair. */
export const DOCUMENT_TRANSLATION_DELTA_CHARS = 2_000;
function deltaSlices(text: string): string[] {
	const slices: string[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + DOCUMENT_TRANSLATION_DELTA_CHARS);
		const code = text.charCodeAt(end - 1);
		if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
		slices.push(text.slice(start, end));
		start = end;
	}
	return slices;
}

/** Split Markdown into translation chunks at blank lines outside fenced code. */
export function splitMarkdownForTranslation(text: string, maxChars = DOCUMENT_TRANSLATION_CHUNK_CHARS): DocumentPiece[] {
	let source = text.replace(/\r\n?/gu, "\n");
	const pieces: DocumentPiece[] = [];
	const frontMatter = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/u.exec(source);
	if (frontMatter) {
		pieces.push({ text: frontMatter[0].replace(/\n+$/u, ""), translate: false });
		source = source.slice(frontMatter[0].length);
	}

	const blocks: DocumentPiece[] = [];
	let current: string[] = [];
	let fence: { marker: string; length: number } | undefined;
	let currentIsFence = false;
	const flush = () => {
		const body = current.join("\n");
		if (body.trim()) blocks.push({ text: body, translate: !currentIsFence });
		current = [];
		currentIsFence = false;
	};
	for (const line of source.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		if (fence) {
			current.push(line);
			if (marker && marker[0] === fence.marker && marker.length >= fence.length && line.trim() === marker) {
				fence = undefined;
				if (currentIsFence) flush();
			}
			continue;
		}
		if (marker) {
			const startsBlock = current.length === 0;
			if (startsBlock) currentIsFence = true;
			current.push(line);
			fence = { marker: marker[0]!, length: marker.length };
			continue;
		}
		if (!line.trim()) { flush(); continue; }
		if (currentIsFence) flush();
		current.push(line);
	}
	flush();

	let chunk: string[] = [];
	let size = 0;
	const flushChunk = () => {
		if (chunk.length) pieces.push({ text: chunk.join(PIECE_SEPARATOR), translate: true });
		chunk = [];
		size = 0;
	};
	for (const block of blocks) {
		if (!block.translate) { flushChunk(); pieces.push(block); continue; }
		for (const part of splitOversized(block.text, maxChars)) {
			if (size > 0 && size + PIECE_SEPARATOR.length + part.length > maxChars) flushChunk();
			chunk.push(part);
			size += (size > 0 ? PIECE_SEPARATOR.length : 0) + part.length;
		}
	}
	flushChunk();
	return pieces;
}

function splitOversized(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const parts: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		for (let start = 0; start < Math.max(1, line.length); start += maxChars) {
			const slice = line.slice(start, start + maxChars);
			if (current && current.length + 1 + slice.length > maxChars) { parts.push(current); current = ""; }
			current = current ? `${current}\n${slice}` : slice;
		}
	}
	if (current) parts.push(current);
	return parts;
}

function documentTranslateSystemPrompt(language: string): string {
	return `You are a translator of Markdown documentation. Translate one section of a larger Markdown document into the language with this code/name: ${language}.
Preserve the Markdown structure exactly: headings, lists, tables, emphasis, blockquotes, HTML tags, line breaks and blank lines.
Keep code spans, fenced code, identifiers, file paths, URLs, link targets, image sources and HTML attributes unchanged; translate only human-readable text, including link and image labels.
If the text is already in the target language, return it unchanged.
Output only the translated section, without wrapping tags, code fences or commentary.`;
}

function buildDocumentChunkPrompt(text: string, path: string | undefined): string {
	return [...(path ? [`Document: ${path}`] : []), "<section>", text, "</section>"].join("\n");
}
