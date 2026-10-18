import type { UsageSourceSnapshot } from "../../../acp/src/acp/usage-stats-contract";
import type { ProviderUsageEntry } from "../app/provider-usage.svelte";
import type { ModelUsageStatus, RuntimeStatus } from "./acp-client";
import { providerUsageLimits, providerUsageLimitKey, type ProviderUsageSummary } from "./provider-usage-limits";
import { quotaProviderForRoute } from "./provider-usage-targets";

type QuotaProvider = ModelUsageStatus["provider"];
export type ProviderUsageFrequency = ReadonlyMap<QuotaProvider, number>;
export type ProviderUsageRow = { key: string; provider: QuotaProvider } & (
  | { kind: "quota"; usage: ProviderUsageSummary }
  | { kind: "missing"; entry: ProviderUsageEntry }
);

/** Account quotas are global: rank by calls across all available history, not chart filters/tokens. */
export function providerUsageFrequency(snapshot: UsageSourceSnapshot | undefined): ProviderUsageFrequency {
  const counts = new Map<QuotaProvider, number>();
  for (const bucket of snapshot?.buckets ?? []) {
    const provider = quotaProviderForRoute(bucket.provider);
    const calls = bucket.values.calls;
    if (!provider || calls === undefined || !Number.isFinite(calls) || calls <= 0) continue;
    counts.set(provider, (counts.get(provider) ?? 0) + calls);
  }
  return counts;
}

/** Partial/failed/empty history must not replace the order restored before quota loading. */
export function providerUsageOrder(snapshot: UsageSourceSnapshot | undefined, previous: readonly string[]): readonly string[] {
  if (snapshot?.status !== "ready") return previous;
  const frequency: ReadonlyMap<string, number> = providerUsageFrequency(snapshot);
  if (frequency.size === 0) return previous;
  const ranks = new Map(previous.map((provider, index) => [provider, index]));
  return [...new Set([...previous, ...frequency.keys()])].sort((a, b) =>
    (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0)
    || (ranks.get(a) ?? previous.length) - (ranks.get(b) ?? previous.length)
    || a.localeCompare(b));
}

/** Keep quota charts and missing-provider placeholders in the same popularity order. */
export function providerUsageRows(
  statuses: readonly RuntimeStatus[], entries: readonly ProviderUsageEntry[], now: number,
  order: readonly string[],
): ProviderUsageRow[] {
  const providers = providerUsageLimits(statuses, now);
  const present = new Set(providers.map((usage) => usage.provider));
  const missing = new Map<QuotaProvider, ProviderUsageEntry>();
  const priority = { loading: 0, failed: 1, unavailable: 2, ready: 3 };
  for (const entry of entries) {
    if (present.has(entry.provider)) continue;
    const previous = missing.get(entry.provider);
    if (!previous || priority[entry.state] < priority[previous.state]
      || (priority[entry.state] === priority[previous.state] && entry.modelRef.localeCompare(previous.modelRef) < 0)) {
      missing.set(entry.provider, entry);
    }
  }
  const rows: ProviderUsageRow[] = providers.map((usage) => ({
    key: providerUsageLimitKey(usage), provider: usage.provider, kind: "quota", usage,
  }));
  for (const entry of missing.values()) {
    rows.push({ key: providerUsageLimitKey(entry), provider: entry.provider, kind: "missing", entry });
  }
  const ranks = new Map(order.map((provider, index) => [provider, index]));
  return rows.sort((a, b) => (ranks.get(a.provider) ?? order.length) - (ranks.get(b.provider) ?? order.length)
    || a.key.localeCompare(b.key));
}
