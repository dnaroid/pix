import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeToolName, parseArgsText } from "../tool-renderers/utils.js";

type CompressResult = {
	tokensSaved?: unknown;
	contextTokens?: unknown;
	contextWindow?: unknown;
	contextPercent?: unknown;
	itemCount?: unknown;
	ranges?: unknown;
	messages?: unknown;
	totalSummaryTokens?: unknown;
	activeBlocks?: unknown;
	totalBlocks?: unknown;
	prunedTools?: unknown;
};

type DcpSessionStats = {
	runs: number;
	tokensSaved: number;
	items: number;
	summaryTokens: number;
	prunedTools: number;
	activeBlocks?: number;
	totalBlocks?: number;
	contextTokens?: number;
	contextWindow?: number;
	contextPercent?: number;
};

export function formatDcpStatsToast(session: AgentSession): string {
	const stats = collectDcpSessionStats(session);
	const parts = [
		`context ${formatContextUsage(stats)}`,
		`freed ${formatCompactNumber(stats.tokensSaved)} tokens`,
		`${stats.runs.toLocaleString()} ${plural(stats.runs, "run")}`,
		stats.items > 0 ? `${stats.items.toLocaleString()} ${plural(stats.items, "item")}` : undefined,
		stats.summaryTokens > 0 ? `${formatCompactNumber(stats.summaryTokens)} summary` : undefined,
		stats.activeBlocks != null && stats.totalBlocks != null ? `blocks ${stats.activeBlocks}/${stats.totalBlocks}` : undefined,
		stats.prunedTools > 0 ? `pruned ${stats.prunedTools.toLocaleString()} tools` : undefined,
	].filter((part): part is string => Boolean(part));

	return `DCP: ${parts.join(" · ")}`;
}

function collectDcpSessionStats(session: AgentSession): DcpSessionStats {
	const usage = session.getContextUsage();
	const stats: DcpSessionStats = {
		runs: 0,
		tokensSaved: 0,
		items: 0,
		summaryTokens: 0,
		prunedTools: 0,
		...(usage?.tokens != null ? { contextTokens: usage.tokens } : {}),
		...(usage?.contextWindow != null ? { contextWindow: usage.contextWindow } : {}),
		...(usage?.percent != null ? { contextPercent: usage.percent } : {}),
	};

	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (normalizeToolName(message.toolName) !== "compress") continue;
		if ("isError" in message && message.isError === true) continue;

		const result = parseToolResultText(message.content);
		if (!result) continue;

		stats.runs += 1;
		stats.tokensSaved += numberValue(result.tokensSaved) ?? 0;
		stats.items += numberValue(result.itemCount) ?? sumDefined(numberValue(result.ranges), numberValue(result.messages)) ?? 0;
		stats.summaryTokens += numberValue(result.totalSummaryTokens) ?? 0;
		stats.prunedTools += numberValue(result.prunedTools) ?? 0;

		const activeBlocks = numberValue(result.activeBlocks);
		const totalBlocks = numberValue(result.totalBlocks);
		if (activeBlocks != null) stats.activeBlocks = activeBlocks;
		if (totalBlocks != null) stats.totalBlocks = totalBlocks;

		const contextTokens = numberValue(result.contextTokens);
		const contextWindow = numberValue(result.contextWindow);
		const contextPercent = numberValue(result.contextPercent);
		if (stats.contextTokens == null && contextTokens != null) stats.contextTokens = contextTokens;
		if (stats.contextWindow == null && contextWindow != null) stats.contextWindow = contextWindow;
		if (stats.contextPercent == null && contextPercent != null) stats.contextPercent = contextPercent;
	}

	return stats;
}

function parseToolResultText(content: unknown): CompressResult | undefined {
	const parsed = parseArgsText(textContent(content));
	return isRecord(parsed) ? parsed : undefined;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
		.filter(Boolean)
		.join("\n");
}

function formatContextUsage(stats: DcpSessionStats): string {
	const percent = stats.contextPercent;
	const tokens = stats.contextTokens;
	const window = stats.contextWindow;
	const percentText = percent != null ? formatPercent(percent) : "unknown";
	if (tokens != null && window != null) return `${percentText} (${formatCompactNumber(tokens)}/${formatCompactNumber(window)})`;
	if (tokens != null) return `${formatCompactNumber(tokens)} tokens`;
	if (window != null) return `${percentText} of ${formatCompactNumber(window)}`;
	return percentText;
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
	return Math.round(value).toLocaleString();
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
