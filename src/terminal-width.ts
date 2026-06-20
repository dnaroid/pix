const TAB_WIDTH = 4;
const ANSI_RESET = "\x1b[0m";
const EMOJI_PRESENTATION_REGEX = /\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR_REGEX = /[\u{1F1E6}-\u{1F1FF}]/u;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

type DisplayCluster = {
	text: string;
	width: number;
	ansi: boolean;
};

export function expandTabs(text: string, tabWidth = TAB_WIDTH): string {
	if (!text.includes("\t")) return text;

	let result = "";
	let column = 0;

	for (const cluster of displayClusters(text)) {
		if (cluster.ansi) {
			result += cluster.text;
			continue;
		}

		if (cluster.text === "\n") {
			result += cluster.text;
			column = 0;
			continue;
		}

		if (cluster.text === "\t") {
			const spaces = tabWidth - (column % tabWidth || tabWidth);
			const count = spaces === 0 ? tabWidth : spaces;
			result += " ".repeat(count);
			column += count;
			continue;
		}

		result += cluster.text;
		column += cluster.width;
	}

	return result;
}

export function stringDisplayWidth(text: string): number {
	if (isPrintableAscii(text)) return text.length;

	let width = 0;
	for (const cluster of displayClusters(text)) {
		width += cluster.width;
	}
	return width;
}

export function sliceByDisplayWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (isPrintableAscii(text)) return text.slice(0, safeWidth);

	let result = "";
	let used = 0;
	let sawAnsi = false;
	let clipped = false;

	for (const cluster of displayClusters(text)) {
		if (cluster.ansi) {
			result += cluster.text;
			sawAnsi = true;
			continue;
		}

		if (used + cluster.width > safeWidth) {
			clipped = true;
			break;
		}
		result += cluster.text;
		used += cluster.width;
	}

	if (sawAnsi && clipped && !result.endsWith(ANSI_RESET)) return `${result}${ANSI_RESET}`;
	return result;
}

export function displayIndexForColumn(text: string, column: number): number {
	const targetColumn = Math.max(1, column);
	let displayColumn = 1;

	for (const cluster of indexedDisplayClusters(text)) {
		if (targetColumn <= displayColumn) return cluster.start;
		if (cluster.ansi || cluster.width <= 0) continue;

		const nextColumn = displayColumn + cluster.width;
		if (targetColumn < nextColumn) return cluster.start;
		if (targetColumn === nextColumn) return cluster.end;
		displayColumn = nextColumn;
	}

	return text.length;
}

export function sliceByDisplayColumns(text: string, startColumn: number, endColumn: number): string {
	const startIndex = displayIndexForColumn(text, startColumn);
	const endIndex = Math.max(startIndex, displayIndexForColumn(text, endColumn));
	return text.slice(startIndex, endIndex);
}

export type DisplayGrapheme = { text: string; width: number; start: number; end: number };

/**
 * Grapheme clusters of `text` with their display width and absolute string
 * indices. Iterating graphemes (instead of code points) is required for correct
 * width accounting: multi-codepoint emoji such as `⚠️` (U+26A0 U+FE0F), keycaps,
 * skin-tone modifiers and regional-indicator flags are one width-2 cluster even
 * though several of their code points have zero width.
 */
export function displayGraphemes(text: string): DisplayGrapheme[] {
	const graphemes: DisplayGrapheme[] = [];
	for (const cluster of indexedDisplayClusters(text)) {
		graphemes.push({ text: cluster.text, width: cluster.width, start: cluster.start, end: cluster.end });
	}
	return graphemes;
}

export function padOrTrimDisplay(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (isPrintableAscii(text)) {
		const trimmed = text.slice(0, safeWidth);
		return `${trimmed}${" ".repeat(Math.max(0, safeWidth - trimmed.length))}`;
	}

	const trimmed = sliceByDisplayWidth(text, safeWidth);
	return `${trimmed}${" ".repeat(Math.max(0, safeWidth - stringDisplayWidth(trimmed)))}`;
}

export function wrapDisplayLine(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (isPrintableAscii(text)) return wrapPrintableAsciiLine(text, safeWidth);

	const chunks: string[] = [];
	let chunk = "";
	let chunkWidth = 0;

	for (const cluster of displayClusters(text)) {
		if (cluster.ansi) {
			chunk += cluster.text;
			continue;
		}

		if (chunk && chunkWidth + cluster.width > safeWidth) {
			chunks.push(chunk);
			chunk = "";
			chunkWidth = 0;
		}

		chunk += cluster.text;
		chunkWidth += cluster.width;
	}

	chunks.push(chunk);
	return chunks;
}

export function wrapDisplayLineByWords(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (stringDisplayWidth(text) <= safeWidth) return [text];

	const chunks: string[] = [];
	let chunk = "";

	for (const token of displayTokens(text)) {
		if (token.whitespace) {
			if (!chunk) {
				chunk = appendTokenToEmptyChunk(token.text, safeWidth, chunks);
				continue;
			}

			const candidate = `${chunk}${token.text}`;
			if (stringDisplayWidth(candidate) <= safeWidth) {
				chunk = candidate;
			} else {
				chunks.push(trimTrailingWhitespace(chunk));
				chunk = "";
			}
			continue;
		}

		if (!chunk) {
			chunk = appendTokenToEmptyChunk(token.text, safeWidth, chunks);
			continue;
		}

		const candidate = `${chunk}${token.text}`;
		if (stringDisplayWidth(candidate) <= safeWidth) {
			chunk = candidate;
			continue;
		}

		chunks.push(trimTrailingWhitespace(chunk));
		chunk = appendTokenToEmptyChunk(token.text, safeWidth, chunks);
	}

	chunks.push(chunk);
	return chunks;
}

function displayTokens(text: string): { text: string; whitespace: boolean }[] {
	const tokens: { text: string; whitespace: boolean }[] = [];
	let current = "";
	let currentWhitespace: boolean | undefined;

	for (const cluster of displayClusters(text)) {
		if (cluster.ansi) {
			current += cluster.text;
			continue;
		}

		const whitespace = /^\s+$/u.test(cluster.text);
		if (current && currentWhitespace !== whitespace) {
			tokens.push({ text: current, whitespace: currentWhitespace ?? false });
			current = "";
		}

		current += cluster.text;
		currentWhitespace = whitespace;
	}

	if (current) tokens.push({ text: current, whitespace: currentWhitespace ?? false });
	return tokens;
}

function appendTokenToEmptyChunk(token: string, width: number, chunks: string[]): string {
	if (stringDisplayWidth(token) <= width) return token;
	const wrapped = wrapDisplayLine(token, width);
	chunks.push(...wrapped.slice(0, -1));
	return wrapped.at(-1) ?? "";
}

function trimTrailingWhitespace(text: string): string {
	return text.replace(/\s+$/u, "");
}

function isPrintableAscii(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function wrapPrintableAsciiLine(text: string, width: number): string[] {
	if (text.length <= width) return [text];

	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += width) {
		chunks.push(text.slice(start, start + width));
	}
	return chunks;
}

function ansiSequenceLength(text: string, index: number): number {
	if (text.charCodeAt(index) !== 0x1b) return 0;
	const next = text[index + 1];
	if (!next) return 1;

	if (next === "[") {
		for (let cursor = index + 2; cursor < text.length; cursor += 1) {
			const code = text.charCodeAt(cursor);
			if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
		}
		return text.length - index;
	}

	if (next === "]") {
		for (let cursor = index + 2; cursor < text.length; cursor += 1) {
			const code = text.charCodeAt(cursor);
			if (code === 0x07) return cursor - index + 1;
			if (code === 0x1b && text[cursor + 1] === "\\") return cursor - index + 2;
		}
		return text.length - index;
	}

	return 2;
}

function* displayClusters(text: string): Generator<DisplayCluster> {
	for (const cluster of indexedDisplayClusters(text)) {
		yield { text: cluster.text, width: cluster.width, ansi: cluster.ansi };
	}
}

function* indexedDisplayClusters(text: string): Generator<DisplayCluster & { start: number; end: number }> {
	for (let index = 0; index < text.length;) {
		const ansiLength = ansiSequenceLength(text, index);
		if (ansiLength > 0) {
			const start = index;
			const cluster = text.slice(index, index + ansiLength);
			index += ansiLength;
			yield { text: cluster, width: 0, ansi: true, start, end: index };
			continue;
		}

		const nextAnsiIndex = text.indexOf("\x1b", index + 1);
		const textEnd = nextAnsiIndex === -1 ? text.length : nextAnsiIndex;
		const segment = text.slice(index, textEnd);
		if (GRAPHEME_SEGMENTER) {
			let segmentOffset = index;
			for (const { segment: cluster } of GRAPHEME_SEGMENTER.segment(segment)) {
				const start = segmentOffset;
				segmentOffset += cluster.length;
				yield { text: cluster, width: graphemeDisplayWidth(cluster), ansi: false, start, end: segmentOffset };
			}
			index = textEnd;
			continue;
		}

		while (index < textEnd) {
			const start = index;
			const codePoint = text.codePointAt(index) ?? 0;
			const cluster = String.fromCodePoint(codePoint);
			index += codePointLength(codePoint);
			yield { text: cluster, width: graphemeDisplayWidth(cluster), ansi: false, start, end: index };
		}
	}
}

function graphemeDisplayWidth(text: string): number {
	if (!text) return 0;
	if (isEmojiGrapheme(text)) return 2;

	let width = 0;
	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index) ?? 0;
		width += charDisplayWidth(codePoint);
		index += codePointLength(codePoint);
	}
	return width;
}

function isEmojiGrapheme(text: string): boolean {
	// Default-presentation emoji (⛔ ✅ 🚀 ❌), supplementary pictographs, and
	// regional-indicator flags render two cells wide in conforming terminals
	// including iTerm2 and Zed, so they are measured at width 2.
	if (EMOJI_PRESENTATION_REGEX.test(text)) return true;
	// Keycap sequences (base + U+FE0F + U+20E3, e.g. 1️⃣) and regional-indicator
	// pairs (🇷🇺) also occupy two cells.
	if (text.includes("\u20e3")) return true;
	if (REGIONAL_INDICATOR_REGEX.test(text) && /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(text)) return true;
	// Symbols promoted to an emoji glyph only by a variation selector (⚠️ ✔️ ©️
	// ☀️) keep their base width of 1. Their base code point is East-Asian-Width
	// Ambiguous, and iTerm2/Zed/wcwidth render them one cell wide; counting them
	// as 2 would misalign table columns and shorten rendered rows.
	return false;
}

function codePointLength(codePoint: number): number {
	return codePoint > 0xffff ? 2 : 1;
}

function charDisplayWidth(codePoint: number): number {
	if (codePoint === 0) return 0;
	if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
	if (isCombining(codePoint)) return 0;
	if (isFullWidth(codePoint)) return 2;
	return 1;
}

function isCombining(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
		codePoint === 0x200d
	);
}

function isFullWidth(codePoint: number): boolean {
	return (
		codePoint >= 0x1100 &&
		(
			codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd)
		)
	);
}
