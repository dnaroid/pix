import type { SessionUsageProvider, SessionUsageReport, SessionUsageTotals } from "./acp-client-types";

export type SessionUsageSort = "totalTokens" | "cost";

export function sortSessionUsageProviders(
  providers: readonly SessionUsageProvider[],
  sort: SessionUsageSort = "totalTokens",
): SessionUsageProvider[] {
  return providers.map((provider) => ({
    ...provider,
    models: [...provider.models].sort((a, b) => b.totals[sort] - a.totals[sort]),
  }));
}

export function providerUsageUrl(provider: string): string | undefined {
  switch (provider) {
    case "pi-claude-code-provider": return "https://claude.ai/code#settings/usage";
    case "openai-codex": return "https://chatgpt.com/settings/usage?tab=overview";
    case "zai": return "https://z.ai/manage-apikey/coding-plan/personal/usage";
    default: return undefined;
  }
}

export function sessionUsageHasValue(value: SessionUsageTotals | undefined): boolean {
  return Boolean(value && (value.cost > 0 || value.totalTokens > 0));
}

export function sessionUsageReportHasValue(report: SessionUsageReport | undefined): boolean {
  return sessionUsageHasValue(report?.totals);
}

export function formatSessionUsageCost(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function formatSessionUsageTokens(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/u, "");
}
