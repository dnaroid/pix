import { expandTabs, stringDisplayWidth } from "./terminal-width.js";
import {
	syntaxHighlightLanguageForMarkdownFence,
	type SyntaxLineHighlight,
	type ToolBodySyntaxHighlight,
	type ToolBodySyntaxHighlights,
} from "./syntax-highlight.js";

export type RenderedMarkdownLine = {
	text: string;
	segments: readonly { start: number; end: number; bold: true }[];
};

export type RenderedMarkdownTextLine = {
	text: string;
	segments?: readonly { start: number; end: number; bold: true }[] | undefined;
	syntaxHighlight?: SyntaxLineHighlight | undefined;
};

type MarkdownTableAlignment = "center" | "left" | "none" | "right";

type MarkdownTableRow = {
	cells: string[];
	indent: string;
};

type MarkdownTableBlock = {
	header: MarkdownTableRow;
	alignments: MarkdownTableAlignment[];
	bodyRows: MarkdownTableRow[];
	lineCount: number;
};

type MarkdownFence = {
	marker: "`" | "~";
	length: number;
	info: string;
};

type ActiveMarkdownFence = MarkdownFence & {
	language: SyntaxLineHighlight["language"] | undefined;
};

export function formatMarkdownTables(text: string, maxWidth?: number): string {
	const lines = text.split("\n");
	const formatted: string[] = [];
	let fence: MarkdownFence | undefined;

	for (let index = 0; index < lines.length;) {
		const line = lines[index] ?? "";
		const nextFence = markdownFence(line);
		if (nextFence) {
			if (!fence) fence = nextFence;
			else if (fence.marker === nextFence.marker && nextFence.length >= fence.length) fence = undefined;
			formatted.push(line);
			index += 1;
			continue;
		}

		if (!fence) {
			const table = parseMarkdownTableBlock(lines, index);
			if (table) {
				formatted.push(...formatMarkdownTableBlock(table, maxWidth));
				index += table.lineCount;
				continue;
			}
		}

		formatted.push(line);
		index += 1;
	}

	return formatted.join("\n");
}

export function renderMarkdownLine(text: string, start = 0): RenderedMarkdownLine {
	const safeStart = Math.max(0, Math.min(text.length, start));
	const segments: { start: number; end: number; bold: true }[] = [];
	let rendered = text.slice(0, safeStart);
	let index = safeStart;
	let inCode = false;

	while (index < text.length) {
		const char = text[index] ?? "";

		if (char === "`" && !isEscaped(text, index)) {
			rendered += char;
			inCode = !inCode;
			index += 1;
			continue;
		}

		if (!inCode && text.startsWith("**", index) && !isEscaped(text, index)) {
			const end = findMarkdownStrongEnd(text, index + 2);
			if (end > index + 2) {
				const segmentStart = rendered.length;
				rendered += text.slice(index + 2, end);
				segments.push({ start: segmentStart, end: rendered.length, bold: true });
				index = end + 2;
				continue;
			}
		}

		rendered += char;
		index += 1;
	}

	return { text: rendered, segments };
}

export function renderMarkdownTextLines(text: string, width: number, start = 0): RenderedMarkdownTextLine[] {
	const lines: RenderedMarkdownTextLine[] = [];
	let fence: ActiveMarkdownFence | undefined;

	for (const rawLine of formatMarkdownTables(sanitizeMarkdownText(text), width).split("\n")) {
		const nextFence = markdownFence(rawLine);
		const closesFence = Boolean(fence && nextFence && fence.marker === nextFence.marker && nextFence.length >= fence.length);
		const opensFence = !fence && nextFence !== undefined;
		const syntaxHighlight = markdownLineSyntaxHighlight(fence, Boolean(opensFence || closesFence), start);

		const markdownLine = syntaxHighlight?.language === "markdown" ? renderMarkdownLine(rawLine) : undefined;
		for (const wrapped of wrapRenderedMarkdownLine(markdownLine ?? { text: rawLine, segments: [] }, width)) {
			lines.push({
				text: wrapped.text,
				...(wrapped.segments.length > 0 ? { segments: wrapped.segments } : {}),
				...(syntaxHighlight ? { syntaxHighlight } : {}),
			});
		}

		if (opensFence && nextFence) {
			fence = { ...nextFence, language: syntaxHighlightLanguageForMarkdownFence(nextFence.info) };
		} else if (closesFence) {
			fence = undefined;
		}
	}

	return lines;
}

export function markdownSyntaxHighlightsForText(text: string, startColumn = 0): ToolBodySyntaxHighlights {
	const highlights: ToolBodySyntaxHighlight[] = [];
	let fence: ActiveMarkdownFence | undefined;

	for (const [lineIndex, line] of text.split("\n").entries()) {
		const nextFence = markdownFence(line);
		const closesFence = Boolean(fence && nextFence && fence.marker === nextFence.marker && nextFence.length >= fence.length);
		const opensFence = !fence && nextFence !== undefined;
		const language = markdownLineSyntaxHighlight(fence, opensFence || closesFence, startColumn)?.language;

		if (language) {
			highlights.push({ language, startLine: lineIndex, endLine: lineIndex + 1, startColumn });
		}

		if (opensFence && nextFence) {
			fence = { ...nextFence, language: syntaxHighlightLanguageForMarkdownFence(nextFence.info) };
		} else if (closesFence) {
			fence = undefined;
		}
	}

	return highlights;
}

function wrapRenderedMarkdownLine(line: RenderedMarkdownLine, width: number): RenderedMarkdownLine[] {
	const safeWidth = Math.max(1, width);
	if (stringDisplayWidth(line.text) <= safeWidth) return [line];

	return wrapDisplayLineByWordsWithRanges(line.text, safeWidth).map((range) => ({
		text: range.text,
		segments: line.segments.flatMap((segment) => shiftSegmentToRange(segment, range.start, range.end)),
	}));
}

function wrapDisplayLineByWordsWithRanges(text: string, width: number): { text: string; start: number; end: number }[] {
	const chunks: { text: string; start: number; end: number }[] = [];
	let chunkText = "";
	let chunkStart = 0;
	let chunkEnd = 0;

	const setChunk = (chunk: { text: string; start: number; end: number }) => {
		chunkText = chunk.text;
		chunkStart = chunk.start;
		chunkEnd = chunk.end;
	};

	const appendTokenToEmptyChunk = (token: DisplayTokenWithRange) => {
		if (stringDisplayWidth(token.text) <= width) {
			setChunk(token);
			return;
		}

		const wrapped = wrapDisplayTokenByWidth(token, width);
		chunks.push(...wrapped.slice(0, -1));
		setChunk(wrapped.at(-1) ?? { text: "", start: token.end, end: token.end });
	};

	for (const token of displayTokensWithRanges(text)) {
		if (token.whitespace) {
			if (!chunkText) {
				appendTokenToEmptyChunk(token);
				continue;
			}

			const candidate = `${chunkText}${token.text}`;
			if (stringDisplayWidth(candidate) <= width) {
				chunkText = candidate;
				chunkEnd = token.end;
			} else {
				chunks.push(trimTrailingWhitespaceChunk(chunkText, chunkStart));
				chunkText = "";
				chunkStart = token.end;
				chunkEnd = token.end;
			}
			continue;
		}

		if (!chunkText) {
			appendTokenToEmptyChunk(token);
			continue;
		}

		const candidate = `${chunkText}${token.text}`;
		if (stringDisplayWidth(candidate) <= width) {
			chunkText = candidate;
			chunkEnd = token.end;
			continue;
		}

		chunks.push(trimTrailingWhitespaceChunk(chunkText, chunkStart));
		appendTokenToEmptyChunk(token);
	}

	chunks.push({ text: chunkText, start: chunkStart, end: chunkEnd });
	return chunks;
}

type DisplayTokenWithRange = {
	text: string;
	start: number;
	end: number;
	whitespace: boolean;
};

function displayTokensWithRanges(text: string): DisplayTokenWithRange[] {
	const tokens: DisplayTokenWithRange[] = [];
	let current = "";
	let currentStart = 0;
	let currentWhitespace: boolean | undefined;

	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const whitespace = /\s/u.test(char);
		if (current && currentWhitespace !== whitespace) {
			tokens.push({ text: current, start: currentStart, end: index, whitespace: currentWhitespace ?? false });
			current = "";
			currentStart = index;
		}

		if (!current) currentStart = index;
		current += char;
		currentWhitespace = whitespace;
		index += char.length;
	}

	if (current) tokens.push({ text: current, start: currentStart, end: text.length, whitespace: currentWhitespace ?? false });
	return tokens;
}

function wrapDisplayTokenByWidth(token: DisplayTokenWithRange, width: number): { text: string; start: number; end: number }[] {
	const chunks: { text: string; start: number; end: number }[] = [];
	let chunkText = "";
	let chunkStart = token.start;
	let chunkWidth = 0;

	for (let index = token.start; index < token.end;) {
		const codePoint = token.text.codePointAt(index - token.start) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const charWidth = stringDisplayWidth(char);
		if (chunkText && chunkWidth + charWidth > width) {
			chunks.push({ text: chunkText, start: chunkStart, end: index });
			chunkText = "";
			chunkStart = index;
			chunkWidth = 0;
		}

		chunkText += char;
		chunkWidth += charWidth;
		index += char.length;
	}

	chunks.push({ text: chunkText, start: chunkStart, end: token.end });
	return chunks;
}

function trimTrailingWhitespaceChunk(text: string, start: number): { text: string; start: number; end: number } {
	const trimmed = text.replace(/\s+$/u, "");
	return { text: trimmed, start, end: start + trimmed.length };
}

function shiftSegmentToRange(segment: { start: number; end: number; bold: true }, rangeStart: number, rangeEnd: number): { start: number; end: number; bold: true }[] {
	const start = Math.max(segment.start, rangeStart);
	const end = Math.min(segment.end, rangeEnd);
	if (end <= start) return [];
	return [{ ...segment, start: start - rangeStart, end: end - rangeStart }];
}

function parseMarkdownTableBlock(lines: readonly string[], start: number): MarkdownTableBlock | undefined {
	const header = parseMarkdownTableRow(lines[start] ?? "");
	if (!header) return undefined;

	const alignments = parseMarkdownTableSeparator(lines[start + 1] ?? "");
	if (!alignments) return undefined;

	const columnCount = Math.max(header.cells.length, alignments.length);
	if (columnCount < 2) return undefined;

	const bodyRows: MarkdownTableRow[] = [];
	let index = start + 2;
	while (index < lines.length) {
		const row = parseMarkdownTableRow(lines[index] ?? "");
		if (!row) break;
		bodyRows.push(row);
		index += 1;
	}

	return { header, alignments, bodyRows, lineCount: index - start };
}

function formatMarkdownTableBlock(table: MarkdownTableBlock, maxWidth?: number): string[] {
	const rows = [table.header, ...table.bodyRows];
	const columnCount = Math.max(table.alignments.length, ...rows.map((row) => row.cells.length));
	const alignments = Array.from({ length: columnCount }, (_, index) => table.alignments[index] ?? "none");
	const widths = markdownTableColumnWidths(rows, alignments, table.header.indent, maxWidth);
	const indent = table.header.indent;

	return [
		formatMarkdownTableBorder(widths, indent, "top"),
		...formatMarkdownTableRow(table.header.cells, widths, alignments, indent),
		formatMarkdownTableBorder(widths, indent, "middle"),
		...formatMarkdownTableBodyRows(table.bodyRows, widths, alignments, indent),
		formatMarkdownTableBorder(widths, indent, "bottom"),
	];
}

function formatMarkdownTableBodyRows(
	rows: readonly MarkdownTableRow[],
	widths: readonly number[],
	alignments: readonly MarkdownTableAlignment[],
	indent: string,
): string[] {
	return rows.flatMap((row, index) => [
		...(index > 0 ? [formatMarkdownTableBorder(widths, indent, "middle")] : []),
		...formatMarkdownTableRow(row.cells, widths, alignments, indent),
	]);
}

function markdownTableColumnWidths(
	rows: readonly MarkdownTableRow[],
	alignments: readonly MarkdownTableAlignment[],
	indent: string,
	maxWidth: number | undefined,
): number[] {
	const naturalWidths = alignments.map((alignment, column) => columnWidth(rows, alignment, column));
	if (maxWidth === undefined) return naturalWidths;

	const availableCellWidth = Math.floor(maxWidth) - stringDisplayWidth(indent) - markdownTableSyntaxWidth(alignments.length) - markdownTableHiddenWidthBudget(rows, alignments.length);
	if (sumWidths(naturalWidths) <= availableCellWidth) return naturalWidths;

	const minWidths = alignments.map(minimumSeparatorWidth);
	if (availableCellWidth <= sumWidths(minWidths)) return minWidths;

	const widths = [...naturalWidths];
	while (sumWidths(widths) > availableCellWidth) {
		const shrinkColumn = widestShrinkableColumn(widths, minWidths);
		if (shrinkColumn < 0) break;
		widths[shrinkColumn] = Math.max(minWidths[shrinkColumn] ?? 0, (widths[shrinkColumn] ?? 0) - 1);
	}

	return widths;
}

function markdownTableSyntaxWidth(columnCount: number): number {
	return columnCount * 3 + 1;
}

function markdownTableHiddenWidthBudget(rows: readonly MarkdownTableRow[], columnCount: number): number {
	let budget = 0;
	for (let column = 0; column < columnCount; column += 1) {
		budget += rows.reduce((width, row) => Math.max(width, markdownHiddenDisplayWidth(row.cells[column] ?? "")), 0);
	}
	return budget;
}

function markdownHiddenDisplayWidth(text: string): number {
	return Math.max(0, stringDisplayWidth(text) - markdownInlineDisplayWidth(text));
}

function sumWidths(widths: readonly number[]): number {
	return widths.reduce((sum, width) => sum + width, 0);
}

function widestShrinkableColumn(widths: readonly number[], minWidths: readonly number[]): number {
	let result = -1;
	let resultRoom = 0;

	for (const [column, width] of widths.entries()) {
		const room = width - (minWidths[column] ?? 0);
		if (room > resultRoom) {
			result = column;
			resultRoom = room;
		}
	}

	return result;
}

function columnWidth(rows: readonly MarkdownTableRow[], alignment: MarkdownTableAlignment, column: number): number {
	const contentWidth = rows.reduce((width, row) => Math.max(width, markdownInlineDisplayWidth(row.cells[column] ?? "")), 0);
	return Math.max(contentWidth, minimumSeparatorWidth(alignment));
}

function minimumSeparatorWidth(alignment: MarkdownTableAlignment): number {
	switch (alignment) {
		case "center":
			return 4;
		case "left":
		case "right":
			return 3;
		case "none":
			return 3;
	}
}

function formatMarkdownTableRow(
	cells: readonly string[],
	widths: readonly number[],
	alignments: readonly MarkdownTableAlignment[],
	indent: string,
): string[] {
	const wrappedCells = widths.map((width, index) => wrapMarkdownTableCell(cells[index] ?? "", width));
	const rowHeight = Math.max(1, ...wrappedCells.map((cell) => cell.length));

	return Array.from({ length: rowHeight }, (_, lineIndex) => {
		const paddedCells = widths.map((width, column) =>
			padMarkdownTableCell(wrappedCells[column]?.[lineIndex] ?? "", width, alignments[column] ?? "none"),
		);
		return `${indent}│ ${paddedCells.join(" │ ")} │`;
	});
}

function formatMarkdownTableBorder(widths: readonly number[], indent: string, position: "bottom" | "middle" | "top"): string {
	const chars = markdownTableBorderChars(position);
	return `${indent}${chars.left}${widths.map((width) => "─".repeat(width + 2)).join(chars.join)}${chars.right}`;
}

function markdownTableBorderChars(position: "bottom" | "middle" | "top"): { left: string; join: string; right: string } {
	switch (position) {
		case "top":
			return { left: "┌", join: "┬", right: "┐" };
		case "middle":
			return { left: "├", join: "┼", right: "┤" };
		case "bottom":
			return { left: "└", join: "┴", right: "┘" };
	}
}

function padMarkdownTableCell(cell: string, width: number, alignment: MarkdownTableAlignment): string {
	const missing = Math.max(0, width - markdownInlineDisplayWidth(cell));
	switch (alignment) {
		case "center": {
			const left = Math.floor(missing / 2);
			return `${" ".repeat(left)}${cell}${" ".repeat(missing - left)}`;
		}
		case "right":
			return `${" ".repeat(missing)}${cell}`;
		case "left":
		case "none":
			return `${cell}${" ".repeat(missing)}`;
	}
}

function wrapMarkdownTableCell(cell: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const words = cell.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];

	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			const wrappedWord = wrapMarkdownTableWord(word, safeWidth);
			lines.push(...wrappedWord.slice(0, -1));
			current = wrappedWord.at(-1) ?? "";
			continue;
		}

		const candidate = `${current} ${word}`;
		if (markdownInlineDisplayWidth(candidate) <= safeWidth) {
			current = candidate;
			continue;
		}

		lines.push(current);
		const wrappedWord = wrapMarkdownTableWord(word, safeWidth);
		lines.push(...wrappedWord.slice(0, -1));
		current = wrappedWord.at(-1) ?? "";
	}

	if (current || lines.length === 0) lines.push(current);
	return lines;
}

function wrapMarkdownTableWord(word: string, width: number): string[] {
	if (markdownInlineDisplayWidth(word) <= width) return [word];

	const inlineCode = /^`([^`]+)`$/.exec(word)?.[1];
	if (inlineCode !== undefined && width > 2) {
		return wrapTextByDisplayWidth(inlineCode, width - 2).map((chunk) => `\`${chunk}\``);
	}

	return wrapTextByDisplayWidth(word, width);
}

function wrapTextByDisplayWidth(text: string, width: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (stringDisplayWidth(remaining) > width) {
		const breakIndex = smartDisplayBreakIndex(remaining, width);
		if (breakIndex <= 0) break;
		chunks.push(remaining.slice(0, breakIndex));
		remaining = remaining.slice(breakIndex);
	}

	if (remaining) chunks.push(remaining);
	return chunks.length > 0 ? chunks : [""];
}

function smartDisplayBreakIndex(text: string, width: number): number {
	let used = 0;
	let fallbackIndex = 0;
	let breakIndex = 0;

	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const nextIndex = index + char.length;
		const nextUsed = used + stringDisplayWidth(char);
		if (nextUsed > width) break;

		used = nextUsed;
		fallbackIndex = nextIndex;
		if (char === "/" && index > 0) breakIndex = index;
		else if (/[._:-]/u.test(char)) breakIndex = nextIndex;
		index = nextIndex;
	}

	return breakIndex > 0 ? breakIndex : fallbackIndex;
}

function markdownInlineDisplayWidth(text: string): number {
	return stringDisplayWidth(renderMarkdownLine(text).text);
}

function findMarkdownStrongEnd(text: string, start: number): number {
	let inCode = false;
	for (let index = start; index < text.length - 1; index += 1) {
		const char = text[index] ?? "";
		if (char === "`" && !isEscaped(text, index)) {
			inCode = !inCode;
			continue;
		}
		if (!inCode && text.startsWith("**", index) && !isEscaped(text, index)) return index;
	}
	return -1;
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function parseMarkdownTableRow(line: string): MarkdownTableRow | undefined {
	const indent = /^\s*/.exec(line)?.[0] ?? "";
	if (indent.includes("\t") || indent.length > 3) return undefined;

	const trimmed = line.trim();
	if (!trimmed.includes("|")) return undefined;

	const cells = splitMarkdownTableCells(trimmed);
	return cells.length >= 2 ? { cells, indent } : undefined;
}

function parseMarkdownTableSeparator(line: string): MarkdownTableAlignment[] | undefined {
	const row = parseMarkdownTableRow(line);
	if (!row) return undefined;

	const alignments = row.cells.map(separatorAlignment);
	return alignments.every((alignment): alignment is MarkdownTableAlignment => alignment !== undefined) ? alignments : undefined;
}

function separatorAlignment(cell: string): MarkdownTableAlignment | undefined {
	const compact = cell.replace(/\s+/g, "");
	if (!/^:?-{2,}:?$/.test(compact)) return undefined;
	const left = compact.startsWith(":");
	const right = compact.endsWith(":");
	if (left && right) return "center";
	if (left) return "left";
	if (right) return "right";
	return "none";
}

function splitMarkdownTableCells(line: string): string[] {
	let body = line;
	if (body.startsWith("|")) body = body.slice(1);
	if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

	const cells: string[] = [];
	let current = "";
	let escaped = false;
	let inCode = false;

	for (const char of body) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}

		if (char === "`") {
			current += char;
			inCode = !inCode;
			continue;
		}

		if (char === "|" && !inCode) {
			cells.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	cells.push(current.trim());
	return cells;
}

function markdownLineSyntaxHighlight(fence: ActiveMarkdownFence | undefined, fenceDelimiterLine: boolean, start: number): SyntaxLineHighlight | undefined {
	if (fenceDelimiterLine) return { language: "markdown", start };
	if (fence) return fence.language ? { language: fence.language, start } : undefined;
	return { language: "markdown", start };
}

function sanitizeMarkdownText(text: string): string {
	return expandTabs(text.replace(/\x1b/g, "␛").replace(/\r/g, ""));
}

function markdownFence(line: string): MarkdownFence | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	const marker = match?.[1];
	if (!marker) return undefined;
	return { marker: marker[0] as "`" | "~", length: marker.length, info: match[2] ?? "" };
}
