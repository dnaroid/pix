import type { ModelUsageStatus, ModelUsageLimitWindow } from "../model/model-usage-status.js";
import { APP_ICONS, type AppIconName } from "../icons.js";
import type { SessionSubagentUsage } from "./session-subagent-usage.js";
import { formatSessionUsageTokens, type SessionUsageReport, type SessionUsageTotals } from "./session-usage.js";

export type TuiUsageFormatOptions = {
	formatModel?: (provider: string, model: string) => string;
	quota?: ModelUsageStatus;
	now?: number;
};

/** Quota is account-wide; spend belongs only to the persisted session. */
export function formatTuiSessionUsage(report: SessionUsageReport, options: TuiUsageFormatOptions = {}): string {
	const lines = ["Session usage", formatSessionUsageTokens(report.totals.totalTokens) + " tokens  " + formatTuiCost(report.totals)];
	const quota = options.quota;
	if (quota) {
		const windows: { label: string; window: ModelUsageLimitWindow }[] = [];
		if (quota.hourly) windows.push({ label: "Hourly", window: quota.hourly });
		if (quota.weekly) windows.push({ label: "Weekly", window: quota.weekly });
		if (windows.length) lines.push("", quota.stale ? "Limits (account-wide, cached)" : "Limits (account-wide)");
		for (const { label, window } of windows) {
			const remaining = Math.min(100, Math.max(0, window.remainingPercent));
			const filled = Math.round(remaining / 10);
			const resetMinutes = Math.ceil((window.resetAt - (options.now ?? Date.now())) / 60_000);
			const reset = resetMinutes > 0 ? "resets in " + formatCountdown(resetMinutes) : "awaiting refresh";
			lines.push(label + ": [" + "█".repeat(filled) + "░".repeat(10 - filled) + "] " + Math.round(remaining) + "% remaining · " + reset);
		}
		if (quota.resetCreditsAvailableCount || quota.resetCredits?.length) {
			lines.push("", "Reset credits: " + (quota.resetCreditsAvailableCount ?? quota.resetCredits?.length ?? 0) + " available");
			for (const credit of quota.resetCredits ?? []) {
				lines.push("  " + credit.title + (credit.count === undefined ? "" : " ×" + credit.count) +
					(credit.expiresAt ? " (expires " + new Date(credit.expiresAt).toLocaleDateString("en-US") + ")" : ""));
			}
		}
	}
	const modelTokens = report.providers.flatMap(({ provider, models }) => models
		.filter((model) => model.totals.totalTokens > 0)
		.map((model) => ({ name: provider + "/" + model.model, totalTokens: model.totals.totalTokens })));
	const attributedTokens = modelTokens.reduce((sum, model) => sum + model.totalTokens, 0);
	if (modelTokens.length > 1 && attributedTokens > 0) {
		lines.push("", "Token usage by model");
		for (const model of modelTokens) {
			const ratio = model.totalTokens / attributedTokens;
			const filled = Math.min(10, Math.max(0, Math.round(ratio * 10)));
			lines.push("  " + model.name + "  [" + "■".repeat(filled) + "·".repeat(10 - filled) + "] " + (ratio * 100).toFixed(1) + "%");
		}
	}
	lines.push("", "Models                         Tokens / Cost");
	if (!report.providers.length && !hasUsage(report.unattributed)) lines.push("No billable usage recorded yet.");
	for (const provider of report.providers) {
		lines.push(provider.provider);
		for (const model of provider.models) {
			lines.push("  " + (options.formatModel?.(provider.provider, model.model) ?? model.model) + "  " +
				formatSessionUsageTokens(model.totals.totalTokens) + " / " + formatTuiCost(model.totals));
		}
	}
	if (hasUsage(report.unattributed)) lines.push("Unattributed  " + formatSessionUsageTokens(report.unattributed.totalTokens) + " / " + formatTuiCost(report.unattributed));
	lines.push("Total  " + formatSessionUsageTokens(report.totals.totalTokens) + " / " + formatTuiCost(report.totals));
	return lines.join("\n");
}

export function formatTuiSubagentUsage(agent: SessionSubagentUsage): string {
	const lines = ["Subagent: " + agent.agentId, "Role: " + formatTuiAgentIcon(agent) + " " + (agent.subagentType ?? "Type not recorded")];
	if (agent.configuredModel) lines.push("Requested model: " + agent.configuredModel);
	if (agent.models.length) lines.push("Recorded models: " + agent.models.map((item) => item.provider + "/" + item.model).join(", "));
	else if (!agent.configuredModel) lines.push("Model not recorded");
	lines.push(agent.usageRecorded ? formatSessionUsageTokens(agent.totals.totalTokens) + " tokens  " + formatTuiCost(agent.totals, true) : "Usage not recorded");
	lines.push("", "Task", agent.task ?? "Task not recorded for this run.");
	if (agent.scope) lines.push("Scope: " + agent.scope);
	if (agent.tools?.length) lines.push("", "Tool calls: " + agent.tools.map((tool) => tool.name + " ×" + tool.count).join(", "));
	if (agent.usageRecorded) {
		lines.push("", "Input: " + exact(agent.totals.input) + "  Output: " + exact(agent.totals.output));
		lines.push("Cache read: " + exact(agent.totals.cacheRead) + "  Cache write: " + exact(agent.totals.cacheWrite));
	}
	lines.push("", agent.runDir ? "Run: " + agent.runDir : "Run identity not recorded (legacy usage).");
	return lines.join("\n");
}

export function formatTuiAgentIcon(agent: SessionSubagentUsage): string {
	return agent.icon && Object.hasOwn(APP_ICONS, agent.icon) ? APP_ICONS[agent.icon as AppIconName] : APP_ICONS.agent;
}

function formatCountdown(minutes: number): string {
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	return (days ? days + "d " : "") + (hours ? hours + "h " : "") + mins + "m";
}

export function formatTuiCost(totals: SessionUsageTotals, markEstimate = false): string {
	const amount = totals.cost <= 0 ? "$0.00" : totals.cost < 0.005 ? "<$0.01" : "$" + totals.cost.toFixed(2);
	return markEstimate && totals.costEstimated ? "~" + amount : amount;
}

export function tuiProviderUsageUrl(provider: string): string | undefined {
	switch (provider) {
		case "pi-claude-code-provider": return "https://claude.ai/code#settings/usage";
		case "openai-codex": return "https://chatgpt.com/settings/usage?tab=overview";
		case "zai": return "https://z.ai/manage-apikey/coding-plan/personal/usage";
		default: return undefined;
	}
}

function exact(value: number): string { return value.toLocaleString("en-US"); }
function hasUsage(value: SessionUsageTotals): boolean { return value.totalTokens > 0 || value.cost > 0; }
