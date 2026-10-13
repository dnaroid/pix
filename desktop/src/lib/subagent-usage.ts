import type { SessionUsageTotals } from "./acp-client-types";
import { formatSessionUsageCost } from "./session-usage";

export function subagentUsageRatio(value: number, main: number): string {
  if (main <= 0) return "—";
  const ratio = value / main * 100;
  if (ratio > 0 && ratio < 0.1) return "<0.1%";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(ratio)}%`;
}

export function subagentUsageCost(totals: SessionUsageTotals): string {
  return `${totals.costEstimated ? "~" : ""}${formatSessionUsageCost(totals.cost)}`;
}
