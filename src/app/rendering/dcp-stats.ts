import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeToolName, parseArgsText } from "../../tool-renderers/utils.js";

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
	stateSource: "journal" | "tool-results";
	manualMode?: boolean;
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
	const branch = dcpStatsBranch(session);
	const latestState = resolveJournalDcpState(branch);
	const stats = collectDcpSessionStats(session, latestState, branch);
	const nudgeStats = collectDcpNudgeStats(branch, latestState?.data);
	const activeBlocks = stats.activeBlocks ?? 0;
	const totalBlocks = stats.totalBlocks ?? stats.activeBlocks ?? 0;
	const totalNudgeEvents = nudgeStats.emitted + nudgeStats.upgraded;
	const activeAnchors = NUDGE_TYPES.reduce((sum, type) => sum + nudgeStats.activeByType[type], 0);

	const lines = [
		"DCP Session Statistics:",
		`  Tokens saved (estimated): ${fmt(stats.tokensSaved)}`,
		`  Total pruning operations: ${fmt(stats.totalPruneCount)}`,
		`  Compression blocks active: ${activeBlocks} / ${totalBlocks} total`,
		`  Manual mode: ${stats.manualMode === true ? "on" : stats.manualMode === false ? "off" : "unknown"}`,
		`  State source: ${formatStateSource(stats.stateSource)}`,
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

function collectDcpSessionStats(
	session: AgentSession,
	latestState: { data: Record<string, unknown>; source: DcpSessionStats["stateSource"] } | undefined,
	branch: readonly any[],
): DcpSessionStats {
	const usage = session.getContextUsage();
	const stats: DcpSessionStats = {
		runs: 0,
		tokensSaved: 0,
		totalPruneCount: 0,
		items: 0,
		summaryTokens: 0,
		prunedTools: 0,
		stateSource: latestState?.source ?? "tool-results",
		...(usage?.tokens != null ? { contextTokens: usage.tokens } : {}),
		...(usage?.contextWindow != null ? { contextWindow: usage.contextWindow } : {}),
		...(usage?.percent != null ? { contextPercent: usage.percent } : {}),
	};

	if (latestState) applyDcpStateStats(stats, latestState.data);

	for (const entry of branch) {
		if (entry.type !== "message") continue;
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
	if (latestState) {
		// Journal state owns durable block/prune counts; successful compress tool
		// results own operation gain because the journal intentionally stores only
		// projection decisions rather than derived accounting snapshots.
		stats.totalPruneCount = Math.max(stats.totalPruneCount, (stats.totalBlocks ?? 0) + stats.prunedTools);
	}

	return stats;
}

function applyDcpStateStats(stats: DcpSessionStats, data: Record<string, unknown>): void {
	stats.tokensSaved = numberValue(data.tokensSaved) ?? stats.tokensSaved;
	stats.tokensSaved += numberValue(data.prunedTokensSaved) ?? 0;
	stats.totalPruneCount = numberValue(data.totalPruneCount) ?? stats.totalPruneCount;
	const blocks = Array.isArray(data.compressionBlocks) ? data.compressionBlocks : undefined;
	if (blocks) {
		stats.totalBlocks = blocks.length;
		stats.activeBlocks = blocks.filter((block) => isRecord(block) && block.active !== false).length;
	}
	if (Array.isArray(data.prunedToolIds)) stats.prunedTools = data.prunedToolIds.length;
	if (typeof data.manualMode === "boolean") stats.manualMode = data.manualMode;
}

function collectDcpNudgeStats(branch: readonly any[], latestState: Record<string, unknown> | undefined): DcpNudgeStats {
	const stats: DcpNudgeStats = {
		emitted: 0,
		upgraded: 0,
		clearedEvents: 0,
		clearedAnchors: 0,
		byType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
		activeByType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
	};

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

function resolveJournalDcpState(branch: readonly any[]): { data: Record<string, unknown>; source: DcpSessionStats["stateSource"] } | undefined {
	const blocks = new Map<number, Record<string, unknown>>();
	const pruned = new Map<string, { reason?: string; tokenEstimate: number }>();
	let initialized = false;
	let manualMode: boolean | undefined;
	let nudgeAnchors: unknown[] = [];
	let lastNudge: unknown;

	for (const entry of branch) {
		const operation = customEntryData(entry, "dcp-journal");
		if (!operation || operation.schemaVersion !== 1) continue;
		if (operation.kind === "init") {
			initialized = true;
			continue;
		}
		if (!initialized || operation.kind !== "delta") continue;
		if (Array.isArray(operation.blocks)) {
			for (const raw of operation.blocks) {
				if (!isRecord(raw) || typeof raw.id !== "number") continue;
				blocks.set(raw.id, { ...raw });
			}
		}
		if (Array.isArray(operation.blockStates)) {
			for (const raw of operation.blockStates) {
				if (!isRecord(raw) || typeof raw.id !== "number") continue;
				const block = blocks.get(raw.id);
				if (!block) continue;
				if (typeof raw.active === "boolean") block.active = raw.active;
				if (typeof raw.deactivatedReason === "string") block.deactivatedReason = raw.deactivatedReason;
			}
		}
		if (Array.isArray(operation.prunedTools)) {
			for (const raw of operation.prunedTools) {
				if (!isRecord(raw) || typeof raw.toolCallId !== "string") continue;
				pruned.set(raw.toolCallId, {
					...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
					tokenEstimate: Math.max(0, numberValue(raw.tokenEstimate) ?? 0),
				});
			}
		}
		if (typeof operation.manualMode === "boolean") manualMode = operation.manualMode;
		if (Array.isArray(operation.nudgeAnchors)) nudgeAnchors = operation.nudgeAnchors;
		if (Object.prototype.hasOwnProperty.call(operation, "lastNudge")) lastNudge = operation.lastNudge ?? undefined;
	}

	if (!initialized) return undefined;
	return {
		source: "journal",
		data: {
			compressionBlocks: [...blocks.values()],
			prunedToolIds: [...pruned.keys()],
			prunedTokensSaved: [...pruned.values()].reduce((sum, item) => sum + item.tokenEstimate, 0),
			manualMode,
			nudgeAnchors,
			lastNudge,
		},
	};
}

function dcpStatsBranch(session: AgentSession): readonly any[] {
	const manager = session.sessionManager as AgentSession["sessionManager"] & {
		readFullBranchEntriesSync?: () => readonly any[];
	};
	try {
		const full = manager.readFullBranchEntriesSync?.();
		if (Array.isArray(full)) return full;
	} catch {
		// Fall back to the manager's currently materialized branch below.
	}
	try {
		const branch = manager.getBranch();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

function formatStateSource(source: DcpSessionStats["stateSource"]): string {
	if (source === "journal") return "session journal";
	return "compress tool results";
}

function customEntryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== customType) return undefined;
	return isRecord(entry.data) ? entry.data : undefined;
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
