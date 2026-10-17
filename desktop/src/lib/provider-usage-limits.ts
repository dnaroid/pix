import type { ModelUsageLimitWindow, ModelUsageStatus, RuntimeStatus } from "./acp-client";
import { displayModelUsage } from "./runtime-status";

export type ProviderUsageSummary = Pick<ModelUsageStatus, "provider" | "accountEmail" | "hourly" | "weekly" | "resetCredits" | "stale"> & {
  readonly iconProvider: string;
};

export function providerUsageLimits(statuses: readonly RuntimeStatus[], now: number): ProviderUsageSummary[] {
  const entries = new Map<string, ModelUsageStatus>();
  for (const status of statuses) {
    const usage = displayModelUsage(status, now);
    // Match the status-bar popover: request-header RPM/TPM are not account quotas.
    if (!usage || (!usage.hourly && !usage.weekly)) continue;
    // First resolve freshness within a model, before summarizing the provider.
    const key = JSON.stringify([providerUsageLimitKey(usage), usage.modelKey]);
    const previous = entries.get(key);
    if (!previous || usage.updatedAt > previous.updatedAt
      || (usage.updatedAt === previous.updatedAt && previous.stale && !usage.stale)) entries.set(key, usage);
  }
  const groups = new Map<string, ModelUsageStatus[]>();
  for (const usage of entries.values()) {
    const key = providerUsageLimitKey(usage);
    const group = groups.get(key) ?? [];
    group.push(usage);
    groups.set(key, group);
  }
  return [...groups.values()].map(summarizeProvider)
    .sort((a, b) => providerUsageLimitKey(a).localeCompare(providerUsageLimitKey(b)));
}

/** Retain the tightest actual window, including its own reset; never average pools. */
function windowSource(entries: readonly ModelUsageStatus[], key: "hourly" | "weekly"): ModelUsageStatus | undefined {
  return entries.filter((entry) => entry[key]).sort((a, b) => {
    const left = a[key] as ModelUsageLimitWindow;
    const right = b[key] as ModelUsageLimitWindow;
    return left.remainingPercent - right.remainingPercent
      || Number(!!a.stale) - Number(!!b.stale)
      || b.updatedAt - a.updatedAt
      || right.resetAt - left.resetAt
      || a.modelKey.localeCompare(b.modelKey);
  })[0];
}

function summarizeProvider(entries: readonly ModelUsageStatus[]): ProviderUsageSummary {
  const ordered = [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.modelKey.localeCompare(b.modelKey));
  const latest = ordered[0]!;
  const hourly = windowSource(ordered, "hourly");
  const weekly = windowSource(ordered, "weekly");
  return {
    provider: latest.provider,
    accountEmail: latest.accountEmail,
    iconProvider: latest.modelKey.split("/")[0] ?? latest.provider,
    hourly: hourly?.hourly,
    weekly: weekly?.weekly,
    resetCredits: ordered.find((entry) => entry.resetCredits !== undefined)?.resetCredits,
    ...(hourly?.stale || weekly?.stale ? { stale: true } : {}),
  };
}

export function providerUsageLimitKey(usage: Pick<ModelUsageStatus, "provider" | "accountEmail">): string {
  return JSON.stringify([usage.provider, usage.accountEmail ?? ""]);
}

export function quotaProviderLabel(provider: ModelUsageStatus["provider"]): string {
  switch (provider) {
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
    case "zhipu": return "Z.ai";
    case "google-antigravity": return "Antigravity";
  }
}
