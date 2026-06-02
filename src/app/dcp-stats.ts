import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeToolName, parseArgsText } from "../tool-renderers/utils.js";

type CompressResult = {
	tokensSaved?: unknown;
	totalPruneCount?: unknown;
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
	totalPruneCount: number;
	items: number;
	summaryTokens: number;
	prunedTools: number;
	activeBlocks?: number;
	totalBlocks?: number;
	contextTokens?: number;
	contextWindow?: number;
	contextPercent?: number;
};

const NUDGE_TYPES = ["turn", "iteration", "context-soft", "context-strong"] as const;
type DcpNudgeType = (typeof NUDGE_TYPES)[number];

type DcpNudgeStats = {
	emitted: number;
	upgraded: number;
	clearedEvents: number;
	clearedAnchors: number;
	byType: Record<DcpNudgeType, number>;
	activeByType: Record<DcpNudgeType, number>;
	last?: {
		type: DcpNudgeType;
		event: "emitted" | "upgraded";
		createdAt?: number;
		contextPercent?: number | null;
	};
};

export function formatDcpStatsToast(session: AgentSession): string {
	const stats = collectDcpSessionStats(session);
	const nudgeStats = collectDcpNudgeStats(session);
	const activeBlocks = stats.activeBlocks ?? 0;
	const totalBlocks = stats.totalBlocks ?? stats.activeBlocks ?? 0;
	const totalNudgeEvents = nudgeStats.emitted + nudgeStats.upgraded;
	const activeAnchors = NUDGE_TYPES.reduce((sum, type) => sum + nudgeStats.activeByType[type], 0);

	const lines = [
		"DCP Session Statistics:",
		`  Tokens saved (estimated): ${fmt(stats.tokensSaved)}`,
		`  Total pruning operations: ${fmt(stats.totalPruneCount)}`,
		`  Compression blocks active: ${activeBlocks} / ${totalBlocks} total`,
		"  Manual mode: off",
		"",
		"Nudge telemetry:",
		`  Sent: ${fmt(nudgeStats.emitted)} emitted, ${fmt(nudgeStats.upgraded)} upgraded`,
		`  By type: ${NUDGE_TYPES.map((type) => `${type}=${fmt(nudgeStats.byType[type])}`).join(", ")}`,
		`  Active anchors: ${fmt(activeAnchors)}${activeAnchors > 0 ? ` (${NUDGE_TYPES.map((type) => `${type}=${fmt(nudgeStats.activeByType[type])}`).join(", ")})` : ""}`,
		`  Cleared after compress: ${fmt(nudgeStats.clearedEvents)} time${nudgeStats.clearedEvents === 1 ? "" : "s"} (${fmt(nudgeStats.clearedAnchors)} anchor${nudgeStats.clearedAnchors === 1 ? "" : "s"})`,
		`  Compliance proxy: ${fmt(nudgeStats.clearedEvents)} compress-after-nudge / ${fmt(totalNudgeEvents)} nudge event${totalNudgeEvents === 1 ? "" : "s"} (${pct(nudgeStats.clearedEvents, totalNudgeEvents)})`,
		nudgeStats.last
			? `  Last nudge: ${nudgeStats.last.type} ${nudgeStats.last.event} at ${formatDate(nudgeStats.last.createdAt)} (${formatContextPercent(nudgeStats.last.contextPercent)})`
			: "  Last nudge: none recorded",
		"",
		`Context: ${formatContextUsage(stats)}`,
	];

	return lines.join("\n");
}

function collectDcpSessionStats(session: AgentSession): DcpSessionStats {
	const usage = session.getContextUsage();
	const stats: DcpSessionStats = {
		runs: 0,
		tokensSaved: 0,
		totalPruneCount: 0,
		items: 0,
		summaryTokens: 0,
		prunedTools: 0,
		...(usage?.tokens != null ? { contextTokens: usage.tokens } : {}),
		...(usage?.contextWindow != null ? { contextWindow: usage.contextWindow } : {}),
		...(usage?.percent != null ? { contextPercent: usage.percent } : {}),
	};

	const branch = session.sessionManager.getBranch();
	const latestState = latestCustomEntryData(branch, "dcp-state");
	if (latestState) applyDcpStateStats(stats, latestState);

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (latestState) continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (normalizeToolName(message.toolName) !== "compress") continue;
		if ("isError" in message && message.isError === true) continue;

		const result = parseToolResultText(message.content);
		if (!result) continue;

		stats.runs += 1;
		stats.tokensSaved += numberValue(result.tokensSaved) ?? 0;
		stats.totalPruneCount = Math.max(stats.totalPruneCount, numberValue(result.totalPruneCount) ?? 0);
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

function applyDcpStateStats(stats: DcpSessionStats, data: Record<string, unknown>): void {
	stats.tokensSaved = numberValue(data.tokensSaved) ?? stats.tokensSaved;
	stats.totalPruneCount = numberValue(data.totalPruneCount) ?? stats.totalPruneCount;
	const blocks = Array.isArray(data.compressionBlocks) ? data.compressionBlocks : undefined;
	if (blocks) {
		stats.totalBlocks = blocks.length;
		stats.activeBlocks = blocks.filter((block) => isRecord(block) && block.active !== false).length;
	}
	if (Array.isArray(data.prunedToolIds)) stats.prunedTools = data.prunedToolIds.length;
}

function collectDcpNudgeStats(session: AgentSession): DcpNudgeStats {
	const stats: DcpNudgeStats = {
		emitted: 0,
		upgraded: 0,
		clearedEvents: 0,
		clearedAnchors: 0,
		byType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
		activeByType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
	};

	const branch = session.sessionManager.getBranch();
	const latestState = latestCustomEntryData(branch, "dcp-state");
	if (latestState) applyActiveAnchorStats(stats, latestState);

	for (const entry of branch) {
		const data = customEntryData(entry, "dcp-nudge");
		if (!data) continue;
		const event = data.event;
		if ((event === "emitted" || event === "upgraded") && isNudgeType(data.type)) {
			if (event === "emitted") stats.emitted += 1;
			else stats.upgraded += 1;
			stats.byType[data.type] += 1;
			const createdAt = numberValue(data.createdAt);
			const contextPercent = typeof data.contextPercent === "number" || data.contextPercent === null ? data.contextPercent : undefined;
			if (!stats.last || (createdAt ?? 0) >= (stats.last.createdAt ?? 0)) {
				stats.last = {
					type: data.type,
					event,
					...(createdAt !== undefined ? { createdAt } : {}),
					...(contextPercent !== undefined ? { contextPercent } : {}),
				};
			}
		} else if (event === "cleared") {
			stats.clearedEvents += 1;
			stats.clearedAnchors += Math.max(0, numberValue(data.clearedAnchors) ?? 0);
		}
	}

	return stats;
}

function applyActiveAnchorStats(stats: DcpNudgeStats, data: Record<string, unknown>): void {
	stats.activeByType = { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 };
	const anchors = Array.isArray(data.nudgeAnchors) ? data.nudgeAnchors : [];
	for (const anchor of anchors) {
		if (isRecord(anchor) && isNudgeType(anchor.type)) stats.activeByType[anchor.type] += 1;
	}
	const last = isRecord(data.lastNudge) ? data.lastNudge : undefined;
	if (last && isNudgeType(last.type) && !stats.last) {
		const contextPercent = numberValue(last.contextPercent);
		const createdAt = numberValue(last.createdAt);
		stats.last = {
			type: last.type,
			event: "emitted",
			...(createdAt !== undefined ? { createdAt } : {}),
			...(contextPercent !== undefined ? { contextPercent: contextPercent * 100 } : {}),
		};
	}
}

function customEntryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== customType) return undefined;
	return isRecord(entry.data) ? entry.data : undefined;
}

function latestCustomEntryData(entries: readonly unknown[], customType: string): Record<string, unknown> | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const data = customEntryData(entries[i], customType);
		if (data) return data;
	}
	return undefined;
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

function isNudgeType(value: unknown): value is DcpNudgeType {
	return typeof value === "string" && (NUDGE_TYPES as readonly string[]).includes(value);
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString();
}

function pct(numerator: number, denominator: number): string {
	if (denominator <= 0) return "n/a";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatDate(ts: number | undefined): string {
	if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "unknown time";
	return new Date(ts).toLocaleString();
}

function formatContextPercent(value: number | null | undefined): string {
	if (value === null) return "unknown context";
	if (typeof value !== "number" || !Number.isFinite(value)) return "unknown context";
	return `${value.toFixed(1)}% context`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
