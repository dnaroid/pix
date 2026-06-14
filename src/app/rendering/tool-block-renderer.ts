import { resolveColor, type ResolvedToolRule } from "../../config.js";
import type { ToolBodySyntaxHighlight, ToolBodySyntaxHighlights } from "../../syntax-highlight.js";
import { expandTabs, sliceByDisplayWidth, stringDisplayWidth, wrapDisplayLineByWords } from "../../terminal-width.js";
import type { Theme } from "../../theme.js";
import { alertIconPrefixLength, hasToolLspDiagnosticsAfterMutation, lspDiagnosticSeverityForLine, sanitizeText, toolStatusIcon, toolStatusIconColor, wrapLine } from "./render-text.js";
import { APP_ICONS } from "../icons.js";
import type { RenderedLine, StyledSegment } from "../types.js";
import type { ToolBodyLineStyle, ToolHeaderSegment } from "../../tool-renderers/types.js";

const TOOL_BODY_PREFIX = "  ";

function truncatedPreviewMarker(): string {
	return `${APP_ICONS.toolPreviewTruncated} `;
}

function toolBodyGutterPrefix(): string {
	return `${APP_ICONS.toolBodyGutter} `;
}

function toolBodyEndPrefix(): string {
	return `${APP_ICONS.toolBodyEnd} `;
}

export type ToolBlockEntry = {
	id: string;
	toolName: string;
	headerLabel?: string | undefined;
	headerArgs?: string | undefined;
	headerArgsSegments?: readonly ToolHeaderSegment[] | undefined;
	bodyLineStyles?: readonly ToolBodyLineStyle[] | undefined;
	bodyStyle?: "diff" | undefined;
	preserveAnsi?: boolean | undefined;
	expanded: boolean;
	status: "running" | "done";
	isError: boolean;
	output: string;
	collapsedBody: string;
	expandedText: string;
	bodyWrap?: "char" | "word" | undefined;
	syntaxHighlight?: ToolBodySyntaxHighlights | undefined;
};

export type ToolBlockRenderOptions = {
	superCompact?: boolean;
	backgroundOverride?: string;
	skipHeaderBackground?: boolean;
	showGutter?: boolean;
};

export function renderToolBlock(entry: ToolBlockEntry, rule: ResolvedToolRule, width: number, colors: Theme["colors"], options: ToolBlockRenderOptions = {}): RenderedLine[] {
	if (rule.hidden) return [];

	const hasLspDiagnostics = hasToolLspDiagnosticsAfterMutation(entry);
	const expanded = entry.expanded;
	const stateIcon = toolStatusIcon(entry);
	const toolColor = resolveColor(rule.color, colors);
	const toolOutputColor = colors.statusForeground;
	const headerLabel = (entry.headerLabel ?? entry.toolName).toLowerCase();
	const bg = options.backgroundOverride;
	const applyBackground = bg ? (lines: RenderedLine[]) => { for (const line of lines) line.backgroundOverride = bg; } : (_lines: RenderedLine[]) => {};
	const headerPrefix = headerLabel ? `${stateIcon} ${headerLabel}` : stateIcon;
	const headerArgs = formatToolHeaderArgs(entry.headerArgs);
	const headerArgsWidth = width - stringDisplayWidth(headerPrefix) - 1;
	const clippedHeaderArgs = headerArgsWidth > 0 ? sliceByDisplayWidth(headerArgs, headerArgsWidth) : "";
	const target = { kind: "tool" as const, id: entry.id };
	const showGutter = options.showGutter ?? true;
	const header = clippedHeaderArgs ? `${headerPrefix} ${clippedHeaderArgs}` : headerPrefix;
	const headerArgsStart = clippedHeaderArgs ? headerPrefix.length + 1 : header.length;

	const headerLine: RenderedLine = {
		text: header,
		target,
		colorOverride: toolColor,
		...(options.backgroundOverride && !options.skipHeaderBackground ? { backgroundOverride: options.backgroundOverride } : {}),
		segments: [
			{ start: 0, end: stateIcon.length, foreground: toolStatusIconColor(entry, colors), bold: true },
			{ start: stateIcon.length, end: headerPrefix.length, bold: true },
			...headerArgsStyledSegments(headerArgsStart, clippedHeaderArgs.length, entry.headerArgsSegments, colors),
		],
	};
	const headerLines: RenderedLine[] = [headerLine];

	if (expanded) {
		headerLines.push(...renderToolBodyLines(entry.expandedText, width, target, toolOutputColor, entry.bodyStyle, colors, entry.syntaxHighlight, entry.bodyWrap, hasLspDiagnostics, entry.bodyLineStyles, entry.preserveAnsi, showGutter));
		if (options.skipHeaderBackground && headerLines.length > 1) {
			applyBackground(headerLines.slice(1));
		} else {
			applyBackground(headerLines);
		}
		return headerLines;
	}

	if (rule.compactHidden || (rule.defaultExpanded === true && !options.superCompact)) return headerLines;

	const body = entry.collapsedBody.trimEnd();
	if (!body || rule.previewLines === 0) return headerLines;

	if (!options.superCompact) {
		headerLines.push(...renderCollapsedPreviewLines(entry, body, rule, width, target, toolOutputColor, colors, hasLspDiagnostics, showGutter));
		applyBackground(headerLines);
		return headerLines;
	}

	const preview = collapsedInlinePreview(body, rule, entry.preserveAnsi);
	if (!preview.text) return headerLines;

	const separator = " — ";
	const availablePreviewWidth = width - stringDisplayWidth(header) - stringDisplayWidth(separator);
	if (availablePreviewWidth <= 0) return headerLines;

	const markerPrefix = truncatedPreviewMarker();
	const previewText = preview.overflow ? `${markerPrefix}${preview.text}` : preview.text;
	const clippedPreview = sliceByDisplayWidth(previewText, availablePreviewWidth);
	if (!clippedPreview) return headerLines;

	headerLine.text = `${header}${separator}${clippedPreview}`;
	const previewStart = header.length + separator.length;
	const previewTextStart = previewStart + (preview.overflow ? markerPrefix.length : 0);
	headerLine.segments = [
		...(headerLine.segments ?? []),
		...(preview.overflow ? [{ start: previewStart, end: previewStart + 1, foreground: colors.statusDotBase }] : []),
		{ start: previewTextStart, end: headerLine.text.length, foreground: toolOutputColor },
	];
	return headerLines;
}

function renderCollapsedPreviewLines(
	entry: ToolBlockEntry,
	body: string,
	rule: ResolvedToolRule,
	width: number,
	target: NonNullable<RenderedLine["target"]>,
	color: string,
	colors: Theme["colors"],
	hasLspDiagnostics: boolean,
	showGutter: boolean,
): RenderedLine[] {
	const preview = previewBodyText(body, rule.direction, rule.previewLines);
	const allPreviewLines = renderToolBodyLines(
		preview.text,
		width,
		target,
		color,
		entry.bodyStyle,
		colors,
		undefined,
		entry.bodyWrap,
		hasLspDiagnostics,
		entry.bodyLineStyles,
		entry.preserveAnsi,
		showGutter,
		{ rawLineOffset: preview.rawLineOffset, bodyEndsAfterText: !preview.omittedAfter },
	);
	const overflow = preview.omittedBefore || preview.omittedAfter || allPreviewLines.length > rule.previewLines;
	if (!overflow) return allPreviewLines;

	const previewLines = rule.direction === "tail" ? allPreviewLines.slice(-rule.previewLines) : allPreviewLines.slice(0, rule.previewLines);
	return markTruncatedPreviewLine(previewLines, rule.direction, colors.statusDotBase);
}

function collapsedInlinePreview(text: string, rule: ResolvedToolRule, preserveAnsi = false): { text: string; overflow: boolean } {
	const preview = previewBodyText(text, rule.direction, rule.previewLines);
	const rawLines = sanitizeToolBodyText(preview.text, preserveAnsi).split("\n").map((line) => stripAnsi(line).trim()).filter(Boolean);
	if (rawLines.length === 0) return { text: "", overflow: false };

	const selectedLines = rule.direction === "tail" ? rawLines.slice(-rule.previewLines) : rawLines.slice(0, rule.previewLines);
	return { text: selectedLines.join(" "), overflow: preview.omittedBefore || preview.omittedAfter || rawLines.length > rule.previewLines };
}

type PreviewBodyText = {
	text: string;
	rawLineOffset: number;
	omittedBefore: boolean;
	omittedAfter: boolean;
};

function previewBodyText(text: string, direction: ResolvedToolRule["direction"], previewLines: number): PreviewBodyText {
	const rawLines = text.split("\n");
	const previewRawLines = Math.max(1, previewLines + 1);

	if (rawLines.length <= previewRawLines) return { text, rawLineOffset: 0, omittedBefore: false, omittedAfter: false };

	if (direction === "tail") {
		const start = Math.max(0, rawLines.length - previewRawLines);
		return {
			text: rawLines.slice(start).join("\n"),
			rawLineOffset: start,
			omittedBefore: start > 0,
			omittedAfter: false,
		};
	}

	return {
		text: rawLines.slice(0, previewRawLines).join("\n"),
		rawLineOffset: 0,
		omittedBefore: false,
		omittedAfter: rawLines.length > previewRawLines,
	};
}

function markTruncatedPreviewLine(lines: RenderedLine[], direction: ResolvedToolRule["direction"], markerColor: string): RenderedLine[] {
	if (lines.length === 0) return lines;

	const markerIndex = direction === "tail" ? 0 : lines.length - 1;
	const gutterPrefix = toolBodyGutterPrefix();
	const markerPrefix = truncatedPreviewMarker();
	return lines.map((line, index) => {
		if (index !== markerIndex) return line;
		const text = line.text.startsWith(gutterPrefix)
			? `${markerPrefix}${line.text.slice(gutterPrefix.length)}`
			: line.text.startsWith(TOOL_BODY_PREFIX)
				? `${markerPrefix}${line.text.slice(TOOL_BODY_PREFIX.length)}`
				: `${markerPrefix}${line.text}`;
		const existingSegments = (line.segments ?? []).filter((segment) => !(segment.start === 0 && segment.end === 1 && segment.foreground === markerColor));

		return {
			...line,
			text,
			segments: [{ start: 0, end: 1, foreground: markerColor }, ...existingSegments],
		};
	});
}

function renderToolBodyLines(
	text: string,
	width: number,
	target: NonNullable<RenderedLine["target"]>,
	color: string,
	style: "diff" | undefined,
	colors: Theme["colors"],
	syntaxHighlight?: ToolBodySyntaxHighlights | undefined,
	bodyWrap: "char" | "word" | undefined = "char",
	hasLspDiagnostics = false,
	bodyLineStyles?: readonly ToolBodyLineStyle[] | undefined,
	preserveAnsi = false,
	showGutter = false,
	options: { rawLineOffset?: number; bodyEndsAfterText?: boolean } = {},
): RenderedLine[] {
	const displayPrefix = showGutter ? toolBodyGutterPrefix() : TOOL_BODY_PREFIX;
	const prefixWidth = stringDisplayWidth(displayPrefix);
	const bodyWidth = Math.max(1, width - prefixWidth);
	const lines: RenderedLine[] = [];
	const wrapBodyLine = bodyWrap === "word" ? wrapDisplayLineByWords : wrapLine;
	const gutterSegment: StyledSegment | undefined = showGutter
		? { start: 0, end: 1, foreground: colors.statusDotBase }
		: undefined;
	const rawLineOffset = options.rawLineOffset ?? 0;
	for (const [rawLineIndex, rawLine] of sanitizeToolBodyText(text, preserveAnsi).split("\n").entries()) {
		const absoluteRawLineIndex = rawLineOffset + rawLineIndex;
		const ansiLine = preserveAnsi ? ansiStyledLine(rawLine) : undefined;
		const displayLine = ansiLine?.text ?? rawLine;
		const diffStyle = style === "diff" ? diffLineStyle(displayLine, colors) : undefined;
		const lspDiagnosticStyle = hasLspDiagnostics ? lspDiagnosticLineStyle(displayLine, colors) : undefined;
		const bodyLineStyle = bodyLineStyleForLine(bodyLineStyles, absoluteRawLineIndex, colors);
		const lineSyntaxHighlight = syntaxHighlightForLine(syntaxHighlight, absoluteRawLineIndex);
		const wrappedLines = ansiLine && !diffStyle && !lspDiagnosticStyle && !bodyLineStyle && !lineSyntaxHighlight
			? wrapAnsiStyledDisplayLine(ansiLine, bodyWidth)
			: wrapBodyLine(displayLine, bodyWidth).map((wrapped) => ({ text: wrapped, segments: [] as StyledSegment[] }));
		for (const [wrapIndex, wrapped] of wrappedLines.entries()) {
			const line: RenderedLine = {
				text: `${displayPrefix}${wrapped.text}`,
				copyText: `${TOOL_BODY_PREFIX}${wrapped.text}`,
				...(wrapIndex < wrappedLines.length - 1 ? { continuesOnNextLine: true } : {}),
				target,
				colorOverride: color,
			};
			if (diffStyle) {
				const segment: StyledSegment = { start: displayPrefix.length, end: line.text.length, foreground: diffStyle.foreground };
				if (diffStyle.bold != null) segment.bold = diffStyle.bold;
				line.segments = gutterSegment ? [gutterSegment, segment] : [segment];
			} else if (lspDiagnosticStyle?.kind === "alert" && wrapIndex === 0) {
				line.segments = [
					...(gutterSegment ? [gutterSegment] : []),
					{ start: displayPrefix.length, end: displayPrefix.length + lspDiagnosticStyle.length, foreground: colors.warning, bold: true },
				];
			} else if (lspDiagnosticStyle?.kind === "severity") {
				line.segments = [
					...(gutterSegment ? [gutterSegment] : []),
					{ start: displayPrefix.length, end: line.text.length, foreground: lspDiagnosticStyle.foreground },
				];
			} else if (bodyLineStyle && line.text.length > displayPrefix.length) {
				line.segments = [
					...(gutterSegment ? [gutterSegment] : []),
					{ start: displayPrefix.length, end: line.text.length, ...bodyLineStyle },
				];
			} else if (lineSyntaxHighlight) {
				const rawStart = wrapIndex === 0 ? lineSyntaxHighlight.startColumn ?? 0 : 0;
				line.syntaxHighlight = { language: lineSyntaxHighlight.language, start: Math.min(line.text.length, displayPrefix.length + rawStart) };
				if (gutterSegment) line.segments = [gutterSegment];
			} else if (wrapped.segments.length > 0) {
				line.segments = [
					...(gutterSegment ? [gutterSegment] : []),
					...wrapped.segments.map((segment) => ({
						...segment,
						start: segment.start + displayPrefix.length,
						end: segment.end + displayPrefix.length,
					})),
				];
			} else if (gutterSegment) {
				line.segments = [gutterSegment];
			}
			lines.push(line);
		}
	}
	if (showGutter && lines.length > 0 && options.bodyEndsAfterText !== false) {
		const lastLine = lines.at(-1);
		if (!lastLine) return lines;
		const gutterPrefix = toolBodyGutterPrefix();
		if (lastLine.text.startsWith(gutterPrefix)) {
			lastLine.text = `${toolBodyEndPrefix()}${lastLine.text.slice(gutterPrefix.length)}`;
		}
	}
	return lines;
}

type AnsiStyledLine = {
	text: string;
	segments: StyledSegment[];
};

type AnsiStyleState = Omit<StyledSegment, "start" | "end">;

const ANSI_STANDARD_COLORS = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"] as const;
const ANSI_BRIGHT_COLORS = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"] as const;

function sanitizeToolBodyText(text: string, preserveAnsi: boolean): string {
	const withoutCarriageReturns = text.replace(/\r/g, "");
	if (preserveAnsi) return expandTabs(withoutCarriageReturns);
	return sanitizeText(text);
}

function stripAnsi(text: string): string {
	return ansiStyledLine(text).text;
}

function ansiStyledLine(rawLine: string): AnsiStyledLine {
	let text = "";
	let style: AnsiStyleState = {};
	let segmentStart: number | undefined;
	const segments: StyledSegment[] = [];

	const flushSegment = () => {
		if (segmentStart == null || segmentStart >= text.length) return;
		segments.push({ start: segmentStart, end: text.length, ...style });
		segmentStart = undefined;
	};
	const setStyle = (nextStyle: AnsiStyleState) => {
		if (sameAnsiStyle(style, nextStyle)) return;
		flushSegment();
		style = nextStyle;
		if (hasAnsiStyle(style)) segmentStart = text.length;
	};

	for (let index = 0; index < rawLine.length;) {
		const ansiLength = ansiSequenceLength(rawLine, index);
		if (ansiLength > 0) {
			const sequence = rawLine.slice(index, index + ansiLength);
			const nextStyle = applyAnsiSequence(style, sequence);
			if (nextStyle) setStyle(nextStyle);
			index += ansiLength;
			continue;
		}

		const codePoint = rawLine.codePointAt(index) ?? 0;
		text += String.fromCodePoint(codePoint);
		index += codePointLength(codePoint);
	}

	flushSegment();
	return { text, segments };
}

function wrapAnsiStyledDisplayLine(line: AnsiStyledLine, width: number): AnsiStyledLine[] {
	const safeWidth = Math.max(1, width);
	if (line.text.length === 0) return [{ text: "", segments: [] }];

	const ranges: { start: number; end: number }[] = [];
	let start = 0;
	let used = 0;
	for (let index = 0; index < line.text.length;) {
		const codePoint = line.text.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const charWidth = stringDisplayWidth(char);
		if (index > start && used + charWidth > safeWidth) {
			ranges.push({ start, end: index });
			start = index;
			used = 0;
		}
		used += charWidth;
		index += codePointLength(codePoint);
	}
	ranges.push({ start, end: line.text.length });

	return ranges.map((range) => ({
		text: line.text.slice(range.start, range.end),
		segments: line.segments.flatMap((segment) => shiftSegmentToRange(segment, range.start, range.end)),
	}));
}

function shiftSegmentToRange(segment: StyledSegment, rangeStart: number, rangeEnd: number): StyledSegment[] {
	const start = Math.max(segment.start, rangeStart);
	const end = Math.min(segment.end, rangeEnd);
	if (end <= start) return [];
	return [{ ...segment, start: start - rangeStart, end: end - rangeStart }];
}

function applyAnsiSequence(style: AnsiStyleState, sequence: string): AnsiStyleState | undefined {
	const match = /^\x1b\[([\d;:]*)m$/u.exec(sequence);
	if (!match) return undefined;
	const params = ansiSgrParams(match[1] ?? "");
	let next: AnsiStyleState = { ...style };

	for (let index = 0; index < params.length; index += 1) {
		const code = params[index] ?? 0;
		if (code === 0) {
			next = {};
		} else if (code === 1) {
			next.bold = true;
		} else if (code === 22) {
			delete next.bold;
		} else if (code === 4) {
			next.underline = true;
		} else if (code === 24) {
			delete next.underline;
		} else if (code === 9) {
			next.strikethrough = true;
		} else if (code === 29) {
			delete next.strikethrough;
		} else if (code === 39) {
			delete next.foreground;
		} else if (code === 49) {
			delete next.background;
		} else if ((code === 38 || code === 48) && params[index + 1] === 5) {
			const color = ansi256Color(params[index + 2] ?? 0);
			if (code === 38) next.foreground = color;
			else next.background = color;
			index += 2;
		} else if ((code === 38 || code === 48) && params[index + 1] === 2) {
			const color = rgbHex(params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0);
			if (code === 38) next.foreground = color;
			else next.background = color;
			index += 4;
		} else if (code >= 30 && code <= 37) {
			next.foreground = ansiBasicColor(ANSI_STANDARD_COLORS, code - 30);
		} else if (code >= 90 && code <= 97) {
			next.foreground = ansiBasicColor(ANSI_BRIGHT_COLORS, code - 90);
		} else if (code >= 40 && code <= 47) {
			next.background = ansiBasicColor(ANSI_STANDARD_COLORS, code - 40);
		} else if (code >= 100 && code <= 107) {
			next.background = ansiBasicColor(ANSI_BRIGHT_COLORS, code - 100);
		}
	}

	return next;
}

function ansiSgrParams(paramsText: string): number[] {
	if (!paramsText) return [0];
	return paramsText.split(/[;:]/u).map((part) => Number.parseInt(part || "0", 10)).map((value) => Number.isFinite(value) ? value : 0);
}

function ansi256Color(value: number): string {
	const color = Math.max(0, Math.min(255, Math.trunc(value)));
	if (color < 8) return ansiBasicColor(ANSI_STANDARD_COLORS, color);
	if (color < 16) return ansiBasicColor(ANSI_BRIGHT_COLORS, color - 8);
	if (color >= 232) {
		const level = 8 + (color - 232) * 10;
		return rgbHex(level, level, level);
	}

	const offset = color - 16;
	const levels = [0, 95, 135, 175, 215, 255] as const;
	return rgbHex(levels[Math.floor(offset / 36) % 6] ?? 0, levels[Math.floor(offset / 6) % 6] ?? 0, levels[offset % 6] ?? 0);
}

function ansiBasicColor(colors: readonly string[], index: number): string {
	return colors[index] ?? colors[0] ?? "#000000";
}

function rgbHex(red: number, green: number, blue: number): string {
	const channel = (value: number) => Math.max(0, Math.min(255, Math.trunc(value))).toString(16).padStart(2, "0");
	return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function sameAnsiStyle(left: AnsiStyleState, right: AnsiStyleState): boolean {
	return left.foreground === right.foreground
		&& left.background === right.background
		&& left.bold === right.bold
		&& left.underline === right.underline
		&& left.strikethrough === right.strikethrough;
}

function hasAnsiStyle(style: AnsiStyleState): boolean {
	return Boolean(style.foreground || style.background || style.bold || style.underline || style.strikethrough);
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

function codePointLength(codePoint: number): number {
	return codePoint > 0xffff ? 2 : 1;
}

function bodyLineStyleForLine(styles: readonly ToolBodyLineStyle[] | undefined, lineIndex: number, colors: Theme["colors"]): Omit<StyledSegment, "start" | "end"> | undefined {
	const style = styles?.find((candidate) => lineIndex >= candidate.startLine && (candidate.endLine == null || lineIndex < candidate.endLine));
	if (!style) return undefined;
	const { startLine: _startLine, endLine: _endLine, color, foreground, ...segment } = style;
	const resolvedForeground = foreground ?? (color ? colors[color] : undefined);
	return resolvedForeground ? { ...segment, foreground: resolvedForeground } : segment;
}

function lspDiagnosticLineStyle(line: string, colors: Theme["colors"]): { kind: "alert"; length: number } | { kind: "severity"; foreground: string } | undefined {
	const alertLength = alertIconPrefixLength(line);
	if (alertLength != null) return { kind: "alert", length: alertLength };

	const severity = lspDiagnosticSeverityForLine(line);
	if (severity === "error") return { kind: "severity", foreground: colors.error };
	if (severity === "warning") return { kind: "severity", foreground: colors.warning };
	if (severity === "hint") return { kind: "severity", foreground: colors.muted };
	return undefined;
}

function syntaxHighlightForLine(highlights: ToolBodySyntaxHighlights | undefined, lineIndex: number): ToolBodySyntaxHighlight | undefined {
	const list = highlights ? (Array.isArray(highlights) ? highlights : [highlights]) : [];
	return list.find((highlight) => lineIndex >= highlight.startLine && (highlight.endLine == null || lineIndex < highlight.endLine));
}

function diffLineStyle(line: string, colors: Theme["colors"]): { foreground: string; bold?: boolean } | undefined {
	const content = line.trimStart();
	if (/^(?:diff --git|index |\*\*\* (?:Begin|End) Patch)/.test(content)) return { foreground: colors.muted, bold: true };
	if (/^(?:---|\+\+\+|\*\*\* (?:Update|Add|Delete) File:)/.test(content)) return { foreground: colors.statusForeground, bold: true };
	if (/^@@/.test(content)) return { foreground: colors.accent, bold: true };
	if (/^\+/.test(content)) return { foreground: colors.success };
	if (/^-/.test(content)) return { foreground: colors.error };
	return undefined;
}

function formatToolHeaderArgs(argsText: string | undefined): string {
	return sanitizeText(argsText ?? "").replace(/\n+/g, " ").trim();
}

function headerArgsStyledSegments(
	headerArgsStart: number,
	clippedLength: number,
	customSegments: readonly ToolHeaderSegment[] | undefined,
	colors: Theme["colors"],
): StyledSegment[] {
	if (clippedLength <= 0) return [];
	if (!customSegments || customSegments.length === 0) return [{ start: headerArgsStart, end: headerArgsStart + clippedLength, foreground: colors.muted }];

	const segments: StyledSegment[] = [];
	let offset = 0;
	const clippedCustomSegments = customSegments
		.map((segment) => clippedHeaderSegment(segment, clippedLength))
		.filter((segment): segment is ToolHeaderSegment => segment !== undefined)
		.sort((left, right) => left.start - right.start || left.end - right.end);

	for (const segment of clippedCustomSegments) {
		const start = Math.max(offset, segment.start);
		if (start >= segment.end) continue;
		if (start > offset) segments.push({ start: headerArgsStart + offset, end: headerArgsStart + start, foreground: colors.muted });
		segments.push({
			...segment,
			start: headerArgsStart + start,
			end: headerArgsStart + segment.end,
		});
		offset = segment.end;
	}

	if (offset < clippedLength) segments.push({ start: headerArgsStart + offset, end: headerArgsStart + clippedLength, foreground: colors.muted });
	return segments;
}

function clippedHeaderSegment(segment: ToolHeaderSegment, clippedLength: number): ToolHeaderSegment | undefined {
	const start = Math.max(0, Math.min(clippedLength, segment.start));
	const end = Math.max(start, Math.min(clippedLength, segment.end));
	if (end <= start) return undefined;
	return { ...segment, start, end };
}
