import { compactProgressBarSegments, formatCompactProgressBar } from "../context-progress-bar.js";
import type { ToolHeaderSegment, ToolRenderInput, ToolRendererMiddleware } from "./types.js";
import { parseArgsText, stringArg } from "./utils.js";

type CompressResult = {
	blockIds?: unknown;
	topic?: unknown;
	ranges?: unknown;
	messages?: unknown;
	itemCount?: unknown;
	totalSummaryTokens?: unknown;
	activeBlocks?: unknown;
	totalBlocks?: unknown;
	prunedTools?: unknown;
	tokensSaved?: unknown;
	contextTokens?: unknown;
	contextWindow?: unknown;
	contextPercent?: unknown;
};

export const renderCompressTool: ToolRendererMiddleware = (input) => {
	const topic = stringArg(input, ["topic"]);
	const summary = formatCompressSummary(input);
	const header = joinHeaderParts(topic ? { text: topic } : undefined, summary) ?? { text: "" };
	return {
		...(header.text ? { headerArgs: header.text } : {}),
		...(header.segments && header.segments.length > 0 ? { headerArgSegments: header.segments } : {}),
		collapsedBody: "",
		expandedText: fullCompressResponse(input.output, input.status),
	};
};


type HeaderPart = {
	text: string;
	segments?: readonly ToolHeaderSegment[];
};

function formatCompressSummary(input: ToolRenderInput): HeaderPart | undefined {
	const { output, isError, status } = input;
	if (!output) return { text: status === "running" ? "running…" : "(empty)" };
	if (isError) return { text: `error: ${oneLine(output)}` };

	const parsed = parseArgsText(output);
	if (!isRecord(parsed)) return { text: oneLine(output) };
	return formatCompressSuccess(parsed, input.colors);
}

function fullCompressResponse(output: string, status: "running" | "done"): string {
	if (output.trim()) return output.trimEnd();
	return status === "running" ? "running…" : "(empty)";
}

function formatCompressSuccess(result: CompressResult, colors: ToolRenderInput["colors"]): HeaderPart {
	const tokensSaved = numberValue(result.tokensSaved);
	const contextPercent = numberValue(result.contextPercent);
	const contextTokens = numberValue(result.contextTokens);
	const contextWindow = numberValue(result.contextWindow);
	const activeBlocks = numberValue(result.activeBlocks);
	const totalBlocks = numberValue(result.totalBlocks);
	const prunedTools = numberValue(result.prunedTools);
	const itemCount = numberValue(result.itemCount) ?? sumDefined(numberValue(result.ranges), numberValue(result.messages));
	const summaryTokens = numberValue(result.totalSummaryTokens);
	const compressedContextTokens = contextTokens ?? inferContextTokens(contextPercent, contextWindow);
	const originalContextTokens = compressedContextTokens != null && tokensSaved != null ? compressedContextTokens + tokensSaved : undefined;
	const compressedContextPercent = percentOfOriginalContext(compressedContextTokens, originalContextTokens);
	const barPercent = compressedContextPercent ?? contextPercent;

	const parts = [
		{ text: tokensSaved != null ? `saved ${formatCompactNumber(tokensSaved)}` : "compressed" },
		barPercent != null ? progressPart(barPercent, originalContextTokens, colors) : undefined,
		compressedContextPercent != null && contextPercent != null ? { text: `context ${formatPercent(contextPercent)}` } : undefined,
		itemCount != null ? { text: `${itemCount} ${plural(itemCount, "item")}` } : undefined,
		summaryTokens != null ? { text: `${formatCompactNumber(summaryTokens)} summary tokens` } : undefined,
		activeBlocks != null && totalBlocks != null ? { text: `blocks ${activeBlocks}/${totalBlocks}` } : undefined,
		prunedTools != null ? { text: `pruned ${prunedTools} tools` } : undefined,
		barPercent == null && contextTokens != null ? { text: `context ${formatCompactNumber(contextTokens)}` } : undefined,
	].filter((part): part is HeaderPart => Boolean(part));

	return joinHeaderParts(...parts) ?? { text: "compressed" };
}

function progressPart(percent: number, previousContextTokens: number | undefined, colors: ToolRenderInput["colors"]): HeaderPart {
	const text = `${formatCompactProgressBar(percent)} ${formatPercent(percent)}${previousContextTokens != null ? ` of ${formatCompactNumber(previousContextTokens)}` : ""}`;
	return {
		text,
		...(colors ? {
			segments: compactProgressBarSegments(0, percent, {
				fill: colors.statusForeground,
				track: colors.statusDotBase,
			}),
		} : {}),
	};
}

function inferContextTokens(contextPercent: number | undefined, contextWindow: number | undefined): number | undefined {
	if (contextPercent == null || contextWindow == null || contextWindow <= 0) return undefined;
	return (contextPercent / 100) * contextWindow;
}

function percentOfOriginalContext(compressedContextTokens: number | undefined, originalContextTokens: number | undefined): number | undefined {
	if (compressedContextTokens == null || originalContextTokens == null || originalContextTokens <= 0) return undefined;
	return (compressedContextTokens / originalContextTokens) * 100;
}

function joinHeaderParts(...parts: readonly (HeaderPart | undefined)[]): HeaderPart | undefined {
	const defined = parts.filter((part): part is HeaderPart => part !== undefined && Boolean(part.text));
	if (defined.length === 0) return undefined;

	const separator = " · ";
	let offset = 0;
	const segments: ToolHeaderSegment[] = [];
	for (const [index, part] of defined.entries()) {
		if (index > 0) offset += separator.length;
		if (part.segments) segments.push(...part.segments.map((segment) => ({ ...segment, start: segment.start + offset, end: segment.end + offset })));
		offset += part.text.length;
	}
	return {
		text: defined.map((part) => part.text).join(separator),
		...(segments.length > 0 ? { segments } : {}),
	};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumDefined(...values: readonly (number | undefined)[]): number | undefined {
	const defined = values.filter((value): value is number => value != null);
	return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatCompactNumber(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
	return String(value);
}

function formatPercent(value: number): string {
	return `${trimDecimal(value)}%`;
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is CompressResult {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
