import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateClaudeCodeCost } from "./session-usage-pricing.js";
import { aggregateSubagentUsage, type SessionSubagentUsageReport, type SessionUsageCall } from "./session-subagent-usage.js";

export type SessionUsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	costEstimated?: boolean;
};

export type SessionUsageProviderBreakdown = {
	provider: string;
	totals: SessionUsageTotals;
	models: SessionUsageModelBreakdown[];
};

export type SessionUsageModelBreakdown = {
	model: string;
	totals: SessionUsageTotals;
};

export type SessionUsageReport = {
	totals: SessionUsageTotals;
	providers: SessionUsageProviderBreakdown[];
	unattributed: SessionUsageTotals;
	subagents?: SessionSubagentUsageReport;
};

export type FormatSessionUsageOptions = {
	formatModel?: (provider: string, model: string) => string;
};

type FullSessionEntriesReader = {
	readFullSessionEntries?: () => Promise<readonly SessionEntry[]>;
};

type UsageLike = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cacheWrite1h?: unknown;
	totalTokens?: unknown;
	cost?: { total?: unknown };
};

const ZERO_USAGE = Object.freeze<SessionUsageTotals>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });

export async function loadSessionUsageReport(session: AgentSession): Promise<SessionUsageReport> {
	const manager = session.sessionManager as typeof session.sessionManager & FullSessionEntriesReader;
	const entries = typeof manager.readFullSessionEntries === "function"
		? await manager.readFullSessionEntries()
		: manager.getEntries();
	return aggregateSessionUsage(entries);
}

/**
 * Aggregate billable usage for the whole persisted session, including abandoned
 * branches. Billing has already happened even when the user later forks or
 * rewinds, so a session-spend view must not hide those calls.
 */
export function aggregateSessionUsage(entries: readonly unknown[]): SessionUsageReport {
	const totals = zeroUsage();
	const unattributed = zeroUsage();
	const providers = new Map<string, { models: Map<string, SessionUsageTotals>; totals: SessionUsageTotals }>();
	const calls: SessionUsageCall[] = [];

	for (const rawEntry of entries) {
		const record = usageFromEntry(rawEntry);
		if (!record) continue;
		addAttributedUsage(record.provider, record.model, record.totals, totals, unattributed, providers);
		calls.push({ entry: record.entry, totals: record.totals });
	}

	return {
		totals,
		providers: [...providers.entries()]
			.map(([provider, value]) => ({
				provider,
				totals: value.totals,
				models: [...value.models.entries()]
					.map(([model, modelTotals]) => ({ model, totals: modelTotals }))
					.sort((a, b) => b.totals.cost - a.totals.cost || b.totals.totalTokens - a.totals.totalTokens || a.model.localeCompare(b.model)),
			}))
			.sort((a, b) => b.totals.cost - a.totals.cost || b.totals.totalTokens - a.totals.totalTokens || a.provider.localeCompare(b.provider)),
		unattributed,
		subagents: aggregateSubagentUsage(entries, calls),
	};
}

/** One billable record from a persisted session entry. */
export type SessionUsageEntryRecord = {
	entry: Record<string, unknown>;
	/** Missing provider means the usage is `Unattributed`. */
	provider?: string;
	model?: string;
	/** Epoch ms of the call: assistant message timestamp, else the entry timestamp. */
	timestampMs?: number;
	totals: SessionUsageTotals;
};

/**
 * Normalize one persisted entry into its billable usage. This is the single
 * accounting rule shared by the per-session report and time-bucketed usage
 * statistics: explicit `usage` entries and assistant messages carry
 * provider/model identity; tool-result, compaction and branch-summary usage
 * stays unattributed. Other entries return `undefined`.
 */
export function usageFromEntry(rawEntry: unknown): SessionUsageEntryRecord | undefined {
	if (!isRecord(rawEntry)) return undefined;
	if (rawEntry.type === "usage") {
		const provider = stringValue(rawEntry.provider);
		const model = stringValue(rawEntry.model);
		const usage = usageValue(rawEntry.usage, provider, model);
		return usage ? usageRecord(rawEntry, usage, provider, model, timestampMs(rawEntry.timestamp)) : undefined;
	}
	if (rawEntry.type === "message") {
		const message = isRecord(rawEntry.message) ? rawEntry.message : undefined;
		if (!message) return undefined;
		const time = timestampMs(message.timestamp) ?? timestampMs(rawEntry.timestamp);
		if (message.role === "assistant") {
			const provider = stringValue(message.provider);
			const model = stringValue(message.model);
			const usage = usageValue(message.usage, provider, model);
			return usage ? usageRecord(rawEntry, usage, provider, model, time) : undefined;
		}
		if (message.role === "toolResult") {
			const usage = usageValue(message.usage);
			return usage ? usageRecord(rawEntry, usage, undefined, undefined, time) : undefined;
		}
		return undefined;
	}
	if (rawEntry.type === "compaction" || rawEntry.type === "branch_summary") {
		const usage = usageValue(rawEntry.usage);
		return usage ? usageRecord(rawEntry, usage, undefined, undefined, timestampMs(rawEntry.timestamp)) : undefined;
	}
	return undefined;
}

function usageRecord(
	entry: Record<string, unknown>,
	totals: SessionUsageTotals,
	provider: string | undefined,
	model: string | undefined,
	time: number | undefined,
): SessionUsageEntryRecord {
	return {
		entry,
		totals,
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(time === undefined ? {} : { timestampMs: time }),
	};
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatSessionUsageText(report: SessionUsageReport, options: FormatSessionUsageOptions = {}): string {
	const lines = [
		"Session usage",
		`${formatCompactTokens(report.totals.totalTokens)} tokens`,
	];

	if (report.providers.length === 0 && !hasUsage(report.unattributed)) {
		lines.push("");
		lines.push("No billable usage has been recorded for this session yet.");
	} else {
		for (const provider of report.providers) {
			lines.push("", provider.provider);
			for (const model of provider.models) {
				const modelLabel = options.formatModel?.(provider.provider, model.model) ?? model.model;
				lines.push(`  ${modelLabel}  ${formatCompactTokens(model.totals.totalTokens)}`);
			}
		}
		if (hasUsage(report.unattributed)) {
			lines.push("", `Unattributed  ${formatCompactTokens(report.unattributed.totalTokens)}`);
		}
	}
	return lines.join("\n");
}

export function formatSessionUsageTokens(tokens: number): string { return formatCompactTokens(tokens); }

function addAttributedUsage(
	provider: string | undefined,
	model: string | undefined,
	usage: SessionUsageTotals,
	totals: SessionUsageTotals,
	unattributed: SessionUsageTotals,
	providers: Map<string, { models: Map<string, SessionUsageTotals>; totals: SessionUsageTotals }>,
): void {
	addUsage(totals, usage);
	if (!provider) {
		addUsage(unattributed, usage);
		return;
	}
	let entry = providers.get(provider);
	if (!entry) {
		entry = { models: new Map(), totals: zeroUsage() };
		providers.set(provider, entry);
	}
	addUsage(entry.totals, usage);
	const modelName = model ?? "unknown model";
	let modelTotals = entry.models.get(modelName);
	if (!modelTotals) {
		modelTotals = zeroUsage();
		entry.models.set(modelName, modelTotals);
	}
	addUsage(modelTotals, usage);
}

function usageValue(value: unknown, provider?: string, model?: string): SessionUsageTotals | undefined {
	if (!isRecord(value)) return undefined;
	const input = nonNegativeNumber(value.input);
	const output = nonNegativeNumber(value.output);
	const cacheRead = nonNegativeNumber(value.cacheRead);
	const cacheWrite = nonNegativeNumber(value.cacheWrite);
	const cost = isRecord(value.cost) ? nonNegativeNumber(value.cost.total) : 0;
	const summedTokens = input + output + cacheRead + cacheWrite;
	const totalTokens = nonNegativeNumber(value.totalTokens) || summedTokens;
	if (summedTokens === 0 && totalTokens === 0 && cost === 0) return { ...ZERO_USAGE };
	const usage: SessionUsageTotals = { input, output, cacheRead, cacheWrite, totalTokens, cost };
	if (cost === 0) {
		const estimate = estimateClaudeCodeCost(provider, model, usage, nonNegativeNumber(value.cacheWrite1h));
		if (estimate !== undefined) {
			usage.cost = estimate;
			usage.costEstimated = true;
		}
	}
	return usage;
}

function addUsage(target: SessionUsageTotals, value: SessionUsageTotals): void {
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
	target.totalTokens += value.totalTokens;
	target.cost += value.cost;
	if (value.costEstimated) target.costEstimated = true;
}

function hasUsage(value: SessionUsageTotals): boolean {
	return value.totalTokens > 0 || value.cost > 0;
}

function zeroUsage(): SessionUsageTotals { return { ...ZERO_USAGE }; }
function nonNegativeNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function trimDecimal(value: number): string { return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/u, ""); }
function formatCompactTokens(value: number): string {
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
	return Math.round(value).toLocaleString("en-US");
}
