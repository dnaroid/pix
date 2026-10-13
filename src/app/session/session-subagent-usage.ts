import type { SessionUsageTotals } from "./session-usage.js";
import { aggregateSubagentChanges, type SubagentChanges } from "./session-subagent-changes.js";

export type SessionSubagentUsage = {
	key: string;
	agentId: string;
	runDir?: string;
	task?: string;
	scope?: string;
	subagentType?: string;
	icon?: string;
	configuredModel?: string;
	status?: string;
	totals: SessionUsageTotals;
	usageRecorded: boolean;
	tools?: { name: string; count: number }[];
	models: { provider: string; model: string; totals: SessionUsageTotals }[];
};

export type SessionSubagentUsageReport = {
	main: SessionUsageTotals;
	other: SessionUsageTotals;
	totals: SessionUsageTotals;
	unattributed: SessionUsageTotals;
	agents: SessionSubagentUsage[];
	changes?: SubagentChanges;
};

export type SessionUsageCall = { entry: Record<string, unknown>; totals: SessionUsageTotals };

const CUSTOM_TYPE = "pi-tools-suite:subagent-statistics";
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const zero = (): SessionUsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });

function usageIdentity(note: unknown): { runDir: string; agentId: string } | undefined {
	if (typeof note !== "string" || note.startsWith("agent:")) return;
	try {
		const value: unknown = JSON.parse(note);
		if (!record(value) || value.version !== 1) return;
		const runDir = text(value.runDir);
		const agentId = text(value.agentId);
		if (runDir && agentId) return { runDir, agentId };
	} catch { /* Old/unrecognized notes stay unattributed. */ }
}

function add(target: SessionUsageTotals, value: SessionUsageTotals): void {
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) target[field] += value[field];
	if (value.costEstimated) target.costEstimated = true;
}

/** Session-owned telemetry only: never traverse mutable child files or the active-only HUD. */
export function aggregateSubagentUsage(entries: readonly unknown[], calls: readonly SessionUsageCall[]): SessionSubagentUsageReport {
	const result: SessionSubagentUsageReport = { main: zero(), other: zero(), totals: zero(), unattributed: zero(), agents: [] };
	const agents = new Map<string, SessionSubagentUsage>();
	function agent(agentId: string, runDir?: string): SessionSubagentUsage {
		const key = JSON.stringify([runDir ?? null, agentId]);
		let row = agents.get(key);
		if (!row) {
			row = { key, agentId, ...(runDir ? { runDir } : {}), totals: zero(), usageRecorded: false, models: [] };
			agents.set(key, row);
		}
		return row;
	}
	function metadata(runDir: string, value: Record<string, unknown>): SessionSubagentUsage | undefined {
		const id = text(value.id);
		if (!id) return;
		const row = agent(id, runDir);
		for (const field of ["task", "scope", "subagentType", "icon", "status"] as const) {
			const label = text(value[field]);
			if (label) row[field] = label;
		}
		const model = text(value.model);
		if (model) row.configuredModel = model;
		return row;
	}

	// Resolve all run identities before assigning legacy agent-id-only usage.
	for (const entry of entries) {
		if (!record(entry)) continue;
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && record(entry.data) && entry.data.version === 1) {
			const data = entry.data;
			if (data.event !== "task" && data.event !== "tool" && data.event !== "state") continue;
			const runDir = text(data.runDir);
			const row = runDir ? metadata(runDir, data) : undefined;
			if (!row) continue;
			if (data.event === "task") row.tools ??= [];
			if (data.event === "tool" && text(data.toolName)) {
				row.tools ??= [];
				const name = text(data.toolName)!;
				const tool = row.tools.find((item) => item.name === name);
				if (tool) tool.count++;
				else row.tools.push({ name, count: 1 });
			}
		} else if (entry.type === "message" && record(entry.message) && entry.message.role === "toolResult" && entry.message.toolName === "subagents" && record(entry.message.details)) {
			const details = entry.message.details;
			const runDir = text(details.runDir);
			if (!runDir || details.mode !== "spawn") continue;
			for (const values of [details.tasks, details.agents]) {
				if (Array.isArray(values)) for (const value of values) if (record(value)) metadata(runDir, value);
			}
		}
	}
	for (const { entry } of calls) {
		if (entry.type !== "usage" || entry.kind !== "async-subagent") continue;
		const identity = usageIdentity(entry.note);
		if (identity) agent(identity.agentId, identity.runDir);
	}
	const byId = new Map<string, SessionSubagentUsage[]>();
	for (const row of agents.values()) {
		const matches = byId.get(row.agentId) ?? [];
		matches.push(row);
		byId.set(row.agentId, matches);
	}

	for (const { entry, totals } of calls) {
		if (entry.type !== "usage" || entry.kind !== "async-subagent") {
			add(entry.type === "usage" && (entry.kind === "heads-up" || entry.kind === "btw") ? result.other : result.main, totals);
			continue;
		}
		add(result.totals, totals);
		let row: SessionSubagentUsage | undefined;
		const note = text(entry.note);
		if (note?.startsWith("agent:")) {
			const id = text(note.slice(6));
			const matches = id ? byId.get(id) ?? [] : [];
			if (id && matches.length <= 1) row = matches[0] ?? agent(id);
		} else {
			const identity = usageIdentity(note);
			if (identity) row = agent(identity.agentId, identity.runDir);
		}
		if (!row) { add(result.unattributed, totals); continue; }
		row.usageRecorded = true;
		add(row.totals, totals);
		const provider = text(entry.provider) ?? "unknown provider";
		const model = text(entry.model) ?? "unknown model";
		let modelRow = row.models.find((item) => item.provider === provider && item.model === model);
		if (!modelRow) { modelRow = { provider, model, totals: zero() }; row.models.push(modelRow); }
		add(modelRow.totals, totals);
	}
	result.agents = [...agents.values()];
	const changes = aggregateSubagentChanges(entries);
	if (changes) result.changes = changes;
	return result;
}
