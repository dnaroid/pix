import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Theme } from "../../theme.js";
import { colorize } from "../../theme.js";
import {
	buildDcpCapacityMap,
	type DcpCapacityCellKind,
	type DcpContextMapTelemetryView,
} from "../../../external/pi-tools-suite/src/dcp/context-map-view.js";
import { collectDcpStatistics, collectDcpStatisticsAsync, formatDcpStatistics } from "../../../external/pi-tools-suite/src/dcp/statistics.js";

export type FormatDcpStatsOptions = {
	/** Must contain the complete ACTIVE branch, never a presentation cursor. */
	branch?: readonly unknown[];
	historyStatus?: "full" | "unavailable";
};

export type DcpRuntimeStats = {
	tokensSaved?: number;
	contextMap?: DcpContextMapTelemetryView;
};

export type FormatDcpDialogOptions = FormatDcpStatsOptions & {
	runtimeStats?: DcpRuntimeStats;
};

const PIX_DCP_SESSION_RUNTIME_STATS_SYMBOL = Symbol.for("pix.dcp.session-runtime-stats");

/** On-demand TUI path: read the full branch asynchronously without hydrating
 * the lazy presentation manager or blocking terminal input. ACP supplies a
 * complete branch directly to the synchronous formatter instead. */
export async function loadDcpStatsToast(session: AgentSession): Promise<string> {
	const manager = session.sessionManager as AgentSession["sessionManager"] & { readFullBranchEntries?: () => Promise<readonly unknown[]> };
	if (!manager.readFullBranchEntries) return formatDcpStatsToast(session);
  const sessionId = manager.getSessionId?.(), leafId = manager.getLeafId?.();
  const model = session.model;
	try {
		const branch = await manager.readFullBranchEntries();
		if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) {
			throw new Error("Statistics owner changed during read");
		}
		return formatDcpStatsToast(session, { branch, historyStatus: "full" });
	} catch {
		return formatDcpStatsToast(session, { historyStatus: "unavailable" });
	}
}

/** Pix TUI presentation of the same live/durable DCP signals used by Desktop's
 * context panel. Full-history statistics stay on-demand; the prepared context
 * map is read from the owning session manager's read-only runtime bridge. */
/** Returns undefined when the session owner changes while the async read is in
 * flight, so callers can suppress a stale dialog rather than render it as an
 * unavailable-history result. */
export async function loadDcpStatsDialog(session: AgentSession, theme: Theme): Promise<string | undefined> {
	const manager = session.sessionManager as AgentSession["sessionManager"] & { readFullBranchEntries?: () => Promise<readonly unknown[]> };
	// Do not turn a status-bar click into a synchronous lazy-cursor hydration.
	// The synchronous formatter remains available to ACP and explicit callers
	// that provide a complete branch.
	if (!manager.readFullBranchEntries) return renderUnavailableDcpStatsDialog(session, theme);
	const sessionId = manager.getSessionId?.(), leafId = manager.getLeafId?.();
	const model = session.model;
	try {
		const branch = await manager.readFullBranchEntries();
		if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) {
			return undefined;
		}
		const { usage } = dcpStatsInputs(session, { branch, historyStatus: "full" });
		// This intentionally yields while replaying a large durable branch. Check
		// ownership both before and after it, since it may change during a yield.
		if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) return undefined;
		const stats = await collectDcpStatisticsAsync({ branch, historyStatus: "full", model: session.model, usage });
		if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) return undefined;
		return renderDcpStatsDialog(session, theme, stats, { branch, historyStatus: "full" });
	} catch {
		if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) return undefined;
		return renderUnavailableDcpStatsDialog(session, theme);
	}
}

async function renderUnavailableDcpStatsDialog(session: AgentSession, theme: Theme): Promise<string> {
	const inputs = dcpStatsInputs(session, { historyStatus: "unavailable" });
	const stats = await collectDcpStatisticsAsync({ ...inputs, model: session.model });
	return renderDcpStatsDialog(session, theme, stats, { historyStatus: "unavailable" }, inputs);
}

/** TUI and ACP use the same passive report as /dcp stats. Opening this view
 * never re-runs pruning, mutates history, or launches a model. */
export function formatDcpStatsToast(session: AgentSession, options: FormatDcpStatsOptions = {}): string {
	const { branch, historyStatus, usage } = dcpStatsInputs(session, options);
	return formatDcpStatistics({ branch, historyStatus, model: session.model, usage });
}

export function formatDcpStatsDialog(session: AgentSession, theme: Theme, options: FormatDcpDialogOptions = {}): string {
	const { branch, historyStatus, usage } = dcpStatsInputs(session, options);
	const stats = collectDcpStatistics({ branch, historyStatus, model: session.model, usage });
	return renderDcpStatsDialog(session, theme, stats, options, { branch, historyStatus, usage });
}

function renderDcpStatsDialog(session: AgentSession, theme: Theme, stats: any, options: FormatDcpDialogOptions, inputs?: { branch: readonly unknown[]; historyStatus: "full" | "unavailable"; usage: unknown }): string {
	const { historyStatus, usage } = inputs ?? dcpStatsInputs(session, options);
	const runtimeStats = options.runtimeStats ?? readDcpRuntimeStats(session);
	const telemetry = runtimeStats.contextMap;
	const context = normalizeContextUsage(session, usage);
	const map = buildDcpCapacityMap(context, telemetry);
	const lines: string[] = [];

	lines.push(colorize("DCP session statistics", { foreground: theme.colors.heading, bold: true }));
	if (map.occupiedPercent === undefined || map.occupiedTokens === undefined || !context) {
		lines.push(`${colorize("Context", { foreground: theme.colors.muted })}  unknown`);
	} else {
		lines.push(`${colorize("Context", { foreground: theme.colors.muted })}  ${Math.round(map.occupiedPercent)}% · ${formatCompactTokens(map.occupiedTokens)} / ${formatCompactTokens(context.contextWindow)} tokens`);
	}
	lines.push(renderCapacityMap(map.cells, theme));
	lines.push(...contextLegendLines(map, telemetry, theme));
	if (map.occupiedPercent === undefined) {
		lines.push(colorize("Live capacity unavailable; free space is not inferred.", { foreground: theme.colors.muted }));
	} else {
		const estimateNote = map.hasEstimates ? ` · DCP volumes approximate${map.estimatesScaled ? "; scaled to live occupancy" : ""}` : "";
		lines.push(colorize(`${Math.round(map.occupiedPercent)}% occupied${estimateNote}`, { foreground: theme.colors.muted }));
	}

	if (telemetry) {
		lines.push(colorize(`Prepared ${formatPreparedTime(telemetry.generatedAt)} · candidates are advisory, not deletions.`, { foreground: theme.colors.muted }));
	} else {
		lines.push(colorize("DCP category estimates are unavailable.", { foreground: theme.colors.muted }));
	}

	const liveSaved = runtimeStats.tokensSaved === undefined ? "unknown" : `~${formatCompactTokens(runtimeStats.tokensSaved)}`;
	const measuredGain = stats.valid && Number.isFinite(stats.measuredGain)
		? `${formatCompactTokens(stats.measuredGain)} · ${formatCompactTokens(stats.measured ?? 0)} commits`
		: "unknown";
	lines.push(`DCP saved ${liveSaved}   Measured gain ${measuredGain}`);

	if (stats.snapshot && Number.isFinite(stats.snapshot.rawTokens) && Number.isFinite(stats.snapshot.projectedTokens)) {
		const raw = stats.snapshot.rawTokens as number;
		const projected = stats.snapshot.projectedTokens as number;
		lines.push(`Last projection  ${formatCompactTokens(raw)} → ${formatCompactTokens(projected)} · ~${formatCompactTokens(Math.max(0, raw - projected))} reduction`);
	}

	if (stats.valid) {
		lines.push(`Journal blocks  ${stats.active.length} active · ${stats.all.length - stats.active.length} retired`);
	} else if (historyStatus === "unavailable") {
		lines.push(colorize("Journal blocks and measured gains unknown: full history unavailable.", { foreground: theme.colors.muted }));
	} else if (stats.journal === "absent") {
		lines.push(colorize("Journal block state has not been recorded yet.", { foreground: theme.colors.muted }));
	} else {
		lines.push(colorize(`Journal blocks and measured gains unavailable: ${String(stats.journal)}.`, { foreground: theme.colors.muted }));
	}

	return lines.join("\n");
}

function dcpStatsInputs(session: AgentSession, options: FormatDcpStatsOptions): {
	branch: readonly unknown[];
	historyStatus: "full" | "unavailable";
	usage: unknown;
} {
	let branch: readonly unknown[] = [];
	let historyStatus: "full" | "unavailable" = options.historyStatus ?? "full";
	if (historyStatus === "full") {
		try {
			if (options.branch) branch = options.branch;
			else {
				const manager = session.sessionManager as AgentSession["sessionManager"] & { readFullBranchEntriesSync?: () => readonly unknown[] };
				branch = manager.readFullBranchEntriesSync ? manager.readFullBranchEntriesSync() : manager.getBranch();
			}
			if (!Array.isArray(branch) || (branch[0] as { parentId?: unknown } | undefined)?.parentId != null) {
				historyStatus = "unavailable";
				branch = [];
			}
		} catch {
			// A broken full reader is not permission to substitute the UI's lazy tail.
			historyStatus = "unavailable";
			branch = [];
		}
	}
	let usage: unknown;
	try { usage = session.getContextUsage(); } catch { /* Explicitly unknown. */ }
	return { branch, historyStatus, usage };
}

function readDcpRuntimeStats(session: AgentSession): DcpRuntimeStats {
	try {
		const manager = session.sessionManager as AgentSession["sessionManager"] & Record<symbol, unknown>;
		const getter = manager[PIX_DCP_SESSION_RUNTIME_STATS_SYMBOL];
		if (typeof getter !== "function") return {};
		const value = (getter as () => unknown)();
		if (!value || typeof value !== "object") return {};
		const source = value as { tokensSaved?: unknown; contextMap?: unknown };
		const tokensSaved = typeof source.tokensSaved === "number" && Number.isFinite(source.tokensSaved) && source.tokensSaved >= 0
			? Math.round(source.tokensSaved)
			: undefined;
		const contextMap = parseContextMap(source.contextMap);
		return {
			...(tokensSaved !== undefined ? { tokensSaved } : {}),
			...(contextMap ? { contextMap } : {}),
		};
	} catch {
		return {};
	}
}

function parseContextMap(value: unknown): DcpContextMapTelemetryView | undefined {
	if (!value || typeof value !== "object") return undefined;
	const map = value as Partial<DcpContextMapTelemetryView>;
	const estimates = map.tokenEstimates;
	if (!Number.isSafeInteger(map.revision) || (map.revision ?? 0) <= 0
		|| !Number.isSafeInteger(map.sessionEpoch) || (map.sessionEpoch ?? -1) < 0
		|| !Number.isSafeInteger(map.generatedAt) || (map.generatedAt ?? 0) <= 0
		|| !Number.isFinite(new Date(map.generatedAt ?? Number.NaN).getTime())
		|| !estimates) return undefined;
	const values = [estimates.retained, estimates.candidate, estimates.protected, estimates.compressed];
	if (!values.every((token) => Number.isSafeInteger(token) && token >= 0)) return undefined;
	const total = values.reduce((sum, token) => sum + token, 0);
	if (!Number.isSafeInteger(total) || total <= 0) return undefined;
	return map as DcpContextMapTelemetryView;
}

function normalizeContextUsage(session: AgentSession, usage: unknown): { tokens: number | null; contextWindow: number } | undefined {
	const source = usage && typeof usage === "object" ? usage as { tokens?: unknown; contextWindow?: unknown } : undefined;
	const modelWindow = session.model?.contextWindow;
	const contextWindow = typeof modelWindow === "number" && Number.isSafeInteger(modelWindow) && modelWindow > 0
		? modelWindow
		: typeof source?.contextWindow === "number" && Number.isSafeInteger(source.contextWindow) && source.contextWindow > 0
			? source.contextWindow
			: undefined;
	if (contextWindow === undefined) return undefined;
	const tokens = source?.tokens === null ? null
		: typeof source?.tokens === "number" && Number.isSafeInteger(source.tokens) && source.tokens >= 0 ? source.tokens : null;
	return { tokens, contextWindow };
}

function renderCapacityMap(cells: readonly { segments: readonly { kind: DcpCapacityCellKind; share: number }[] }[], theme: Theme): string {
	return cells.map((cell) => {
		const kind = cell.segments.reduce(
			(best, segment) => segment.share > best.share ? segment : best,
			cell.segments[0] ?? { kind: "unknown" as const, share: 1 },
		).kind;
		return colorize(kind === "free" ? "░" : kind === "unknown" ? "?" : "█", { foreground: mapKindColor(kind, theme) });
	}).join("");
}

function contextLegendLines(
	map: ReturnType<typeof buildDcpCapacityMap>,
	telemetry: DcpContextMapTelemetryView | undefined,
	theme: Theme,
): string[] {
	if (map.occupiedPercent === undefined) return [`${legendMark("unknown", theme)} Capacity unknown`];
	const category = map.categoryTokens;
	const lines: string[] = [];
	if (category) {
		lines.push(`${legendMark("retained", theme)} Other ~${formatEstimate(category.retained)}   ${legendMark("candidate", theme)} Candidates ~${formatEstimate(category.candidate)}`);
		lines.push(`${legendMark("protected", theme)} Protected ~${formatEstimate(category.protected)}   ${legendMark("compressed", theme)} Summaries ~${formatEstimate(category.compressed)}`);
	} else {
		lines.push(`${legendMark("occupied", theme)} Occupied ~${formatCompactTokens(map.occupiedTokens ?? 0)}`);
	}
	lines.push(`${legendMark("free", theme)} Free ~${formatCompactTokens(map.freeTokens ?? 0)}`);
	if (telemetry && !map.hasEstimates) lines.push(colorize("Prepared DCP estimates could not be fitted to live occupancy.", { foreground: theme.colors.muted }));
	return lines;
}

function legendMark(kind: DcpCapacityCellKind, theme: Theme): string {
	return colorize(kind === "free" ? "░" : kind === "unknown" ? "?" : "■", { foreground: mapKindColor(kind, theme) });
}

function mapKindColor(kind: DcpCapacityCellKind, theme: Theme): string {
	if (kind === "candidate") return theme.colors.warning;
	if (kind === "protected") return theme.colors.error;
	if (kind === "compressed") return theme.colors.success;
	if (kind === "occupied") return theme.colors.info;
	return theme.colors.muted;
}

function formatEstimate(tokens: number): string {
	return tokens > 0 && tokens < 1 ? "<1" : formatCompactTokens(tokens);
}

function formatCompactTokens(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
	return Math.round(value).toLocaleString("en-US");
}

function trimDecimal(value: number): string {
	return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/u, "");
}

function formatPreparedTime(timestamp: number): string {
	try { return new Date(timestamp).toLocaleString(); }
	catch { return "unknown time"; }
}
