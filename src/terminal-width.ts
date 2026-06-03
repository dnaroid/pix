const TAB_WIDTH = 4;
const ANSI_RESET = "\x1b[0m";
const EMOJI_PRESENTATION_REGEX = /\p{Emoji_Presentation}/u;
const EMOJI_REGEX = /\p{Emoji}/u;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

type DisplayCluster = {
	text: string;
	width: number;
	ansi: boolean;
};

export function expandTabs(text: string, tabWidth = TAB_WIDTH): string {
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
	let width = 0;
	for (const cluster of displayClusters(text)) {
		width += cluster.width;
	}
	return width;
}

export function sliceByDisplayWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
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

export function padOrTrimDisplay(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const trimmed = sliceByDisplayWidth(text, safeWidth);
	return `${trimmed}${" ".repeat(Math.max(0, safeWidth - stringDisplayWidth(trimmed)))}`;
}

export function wrapDisplayLine(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
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
	for (let index = 0; index < text.length;) {
		const ansiLength = ansiSequenceLength(text, index);
		if (ansiLength > 0) {
			const cluster = text.slice(index, index + ansiLength);
			yield { text: cluster, width: 0, ansi: true };
			index += ansiLength;
			continue;
		}

		const nextAnsiIndex = text.indexOf("\x1b", index + 1);
		const textEnd = nextAnsiIndex === -1 ? text.length : nextAnsiIndex;
		const segment = text.slice(index, textEnd);
		if (GRAPHEME_SEGMENTER) {
			for (const { segment: cluster } of GRAPHEME_SEGMENTER.segment(segment)) {
				yield { text: cluster, width: graphemeDisplayWidth(cluster), ansi: false };
			}
			index = textEnd;
			continue;
		}

		while (index < textEnd) {
			const codePoint = text.codePointAt(index) ?? 0;
			const cluster = String.fromCodePoint(codePoint);
			yield { text: cluster, width: graphemeDisplayWidth(cluster), ansi: false };
			index += codePointLength(codePoint);
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
	return EMOJI_PRESENTATION_REGEX.test(text) || (EMOJI_REGEX.test(text) && (text.includes("\ufe0f") || text.includes("\u20e3")));
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
