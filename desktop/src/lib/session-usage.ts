import type { SessionUsageReport, SessionUsageTotals } from "./acp-client-types";

export function sessionUsageHasValue(value: SessionUsageTotals | undefined): boolean {
  return Boolean(value && (value.cost > 0 || value.totalTokens > 0));
}

export function sessionUsageReportHasValue(report: SessionUsageReport | undefined): boolean {
  return sessionUsageHasValue(report?.totals);
}

export function formatSessionUsageCost(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}

export function formatSessionUsageTokens(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/u, "");
}
