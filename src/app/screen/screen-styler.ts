import { ANSI_RESET, ansiStylePrefix, colorize, type Theme } from "../../theme.js";
import { renderMarkdownLine } from "../../markdown-format.js";
import { syntaxHighlightSegmentsForLine } from "../../syntax-highlight.js";
import { displayIndexForColumn } from "../../terminal-width.js";
import { padOrTrimPlain } from "../rendering/render-text.js";
import { orderedSelection } from "./screen-selection.js";
import type { MouseSelection, RenderedLine, StyledSegment } from "../types.js";

export type ScreenStylerHost = {
	readonly theme: Theme;
	readonly cwd?: string;
	readonly mouseSelection: MouseSelection | undefined;
};

export class ScreenStyler {
	constructor(private readonly host: ScreenStylerHost) {}

	styleBaseLine(row: number, line: RenderedLine | undefined, width: number): string {
		const foreground = line?.colorOverride ?? this.baseLineForeground(line?.variant);
		const options = {
			foreground,
			...(line?.backgroundOverride === undefined ? {} : { background: line.backgroundOverride }),
		};
		const colors = this.host.theme.colors;
		const markdownLine = line?.syntaxHighlight?.language === "markdown"
			? renderMarkdownDisplayLine(line.text, width, line.syntaxHighlight.start)
			: undefined;
		const text = markdownLine?.text ?? line?.text ?? "";
		if (line?.syntaxHighlight && !this.selectionRangeForRow(row, width, text)) {
			const syntaxHighlight = markdownLine ? { ...line.syntaxHighlight, start: Math.min(line.syntaxHighlight.start, markdownLine.text.length) } : line.syntaxHighlight;
			const segments = [
				...syntaxHighlightSegmentsForLine(text, syntaxHighlight, colors),
				...(markdownLine?.segments ?? []),
				...(line.segments ?? []),
			];
			if (segments.length > 0) return this.styleLineSegments(row, text, width, options, segments);
		}
		if (line?.segments && line.segments.length > 0) {
			return this.styleLineSegments(row, text, width, options, line.segments);
		}
		return this.styleLine(row, text, width, options);
	}

	styleLineSegments(
		row: number,
		text: string,
		width: number,
		baseOptions: { foreground?: string; background?: string; bold?: boolean; underline?: boolean },
		segments: readonly StyledSegment[],
	): string {
		if (this.selectionRangeForRow(row, width, text)) return this.styleLine(row, text, width, baseOptions);

		const plain = padOrTrimPlain(text, width);
		const chunks: string[] = [];
		let offset = 0;
		const endOffset = plain.length;

		for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
			const start = Math.max(offset, Math.min(endOffset, segment.start));
			const end = Math.max(start, Math.min(endOffset, segment.end));
			if (start > offset) chunks.push(colorize(plain.slice(offset, start), baseOptions));
			if (end > start) chunks.push(colorize(plain.slice(start, end), { ...baseOptions, ...segment }));
			offset = end;
		}

		if (offset < endOffset) chunks.push(colorize(plain.slice(offset, endOffset), baseOptions));
		return chunks.join("");
	}

	styleLine(
		row: number,
		text: string,
		width: number,
		options: { foreground?: string; background?: string; bold?: boolean; underline?: boolean },
	): string {
		const plain = padOrTrimPlain(text, width);
		const range = this.selectionRangeForRow(row, width, plain);
		if (!range) return colorize(plain, options);

		const before = plain.slice(0, range.startIndex);
		const selected = plain.slice(range.startIndex, range.endIndex);
		const after = plain.slice(range.endIndex);
		return [
			colorize(before, options),
			colorize(selected, {
				foreground: this.host.theme.colors.selectionForeground,
				background: this.host.theme.colors.selectionBackground,
				bold: true,
			}),
			colorize(after, options),
		].join("");
	}

	styleInputLine(
		row: number,
		text: string,
		tagSpans: readonly { start: number; end: number }[] | undefined,
		suggestionSpans: readonly { start: number; end: number }[] | undefined,
		width: number,
		tagColor: string,
		suggestionColor: string,
		frameColor?: string,
	): string {
		const colors = this.host.theme.colors;
		const baseOptions = { foreground: colors.userForeground };
		if (this.selectionRangeForRow(row, width, text)) return this.styleLine(row, text, width, baseOptions);

		const plain = padOrTrimPlain(text, width);
		const frameSpans = inputFrameSpans(plain, width, frameColor);
		if ((!tagSpans || tagSpans.length === 0) && (!suggestionSpans || suggestionSpans.length === 0) && frameSpans.length === 0) {
			return hasAnsi(plain) ? this.styleAnsiLine(plain, baseOptions) : colorize(plain, baseOptions);
		}

		const chunks: string[] = [];
		let offset = 0;
		const endOffset = plain.length;
		const spans = [
			...frameSpans,
			...(tagSpans ?? []).map((span) => ({ ...span, foreground: tagColor, bold: true })),
			...(suggestionSpans ?? []).map((span) => ({ ...span, foreground: suggestionColor })),
		].sort((a, b) => a.start - b.start || a.end - b.end);
		for (const span of spans) {
			const start = Math.max(offset, Math.min(endOffset, span.start));
			const end = Math.max(start, Math.min(endOffset, span.end));
			if (start > offset) chunks.push(colorize(plain.slice(offset, start), baseOptions));
			if (end > start) chunks.push(colorize(plain.slice(start, end), { ...baseOptions, ...span }));
			offset = end;
		}
		if (offset < endOffset) chunks.push(colorize(plain.slice(offset), baseOptions));
		return chunks.join("");
	}

	private styleAnsiLine(text: string, options: { foreground?: string; background?: string; bold?: boolean }): string {
		const prefix = ansiStylePrefix(options);
		if (!prefix) return text;
		return `${prefix}${text.replaceAll(ANSI_RESET, `${ANSI_RESET}${prefix}`)}${ANSI_RESET}`;
	}

	selectionRangeForRow(row: number, width: number, text?: string): { startIndex: number; endIndex: number } | undefined {
		if (!this.host.mouseSelection) return undefined;

		const anchor = this.host.mouseSelection.screenAnchor ?? this.host.mouseSelection.anchor;
		const current = this.host.mouseSelection.screenCurrent ?? this.host.mouseSelection.current;
		const { start, end } = orderedSelection(anchor, current);
		if (row < start.y || row > end.y) return undefined;

		const startColumn = row === start.y ? start.x : 1;
		const endColumn = row === end.y ? end.x : width + 1;
		const plain = text ?? " ".repeat(Math.max(0, width));
		const startIndex = Math.max(0, Math.min(plain.length, displayIndexForColumn(plain, startColumn)));
		const endIndex = Math.max(startIndex, Math.min(plain.length, displayIndexForColumn(plain, endColumn)));
		return endIndex > startIndex ? { startIndex, endIndex } : undefined;
	}

	private baseLineForeground(variant: RenderedLine["variant"]): string {
		const colors = this.host.theme.colors;
		switch (variant) {
			case "accent":
				return colors.accent;
			case "error":
				return colors.error;
			case "muted":
				return colors.muted;
			case "normal":
			case undefined:
				return colors.foreground;
		}
	}
}

function hasAnsi(text: string): boolean {
	return text.includes("\x1b[");
}

function renderMarkdownDisplayLine(text: string, width: number, start: number): { text: string; segments: StyledSegment[] } {
	if (width > 1 && text[0] === "│" && text[width - 1] === "│" && start > 0) {
		const innerWidth = Math.max(0, width - 2);
		const inner = renderMarkdownLine(text.slice(1, width - 1), start - 1);
		return {
			text: `│${padOrTrimPlain(inner.text, innerWidth)}│`,
			segments: inner.segments.map((segment) => ({ ...segment, start: segment.start + 1, end: segment.end + 1 })),
		};
	}

	const line = renderMarkdownLine(text, start);
	return { text: line.text, segments: [...line.segments] };
}

function inputFrameSpans(text: string, width: number, frameColor: string | undefined): StyledSegment[] {
	if (!frameColor || width <= 0 || text.length === 0) return [];
	const spans: StyledSegment[] = [];
	if (text[0] === "│") spans.push({ start: 0, end: 1, foreground: frameColor });
	if (width > 1 && text[Math.min(width, text.length) - 1] === "│") {
		spans.push({ start: width - 1, end: width, foreground: frameColor });
	}
	return spans;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
