import type { UsageSourceId, UsageSourceStatus, UsageUnit } from "../../../../acp/src/acp/usage-stats-contract";
import { OTHER_MODEL, UNATTRIBUTED_MODEL, type UsageMetric, type UsagePeriod } from "../../lib/usage-stats";

/** Compact number: 950, 12.3K, 4.5M, 1.2B. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return abs >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

function trim(value: number): string {
  return value.toFixed(Math.abs(value) >= 100 ? 0 : 1).replace(/\.0$/u, "");
}

/** Metric value with unit; `estimated` costs are prefixed with `≈`. */
export function formatMetric(value: number, metric: UsageMetric, estimated = false): string {
  switch (metric) {
    case "cost": {
      const amount = value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value > 0 && value < 0.01 ? "<0.01" : value.toFixed(2);
      return `${estimated ? "≈ " : ""}$${amount}`;
    }
    case "tokens": return `${formatCompact(value)} tok`;
    case "calls": return `${formatCompact(value)} calls`;
  }
}

export const METRIC_LABELS: Readonly<Record<UsageMetric, string>> = {
  cost: "Cost",
  tokens: "Tokens",
  calls: "Calls",
};

export const PERIOD_LABELS: Readonly<Record<UsagePeriod, string>> = { "7d": "7d", "30d": "30d", "90d": "90d", all: "All" };

export const SOURCE_LABELS: Readonly<Record<UsageSourceId, string>> = {
  "pix-sessions": "Pix sessions",
};

export const UNIT_LABELS: Readonly<Record<UsageUnit, string>> = {
  tokens: "tokens",
};

export const STATUS_LABELS: Readonly<Record<UsageSourceStatus, string>> = {
  loading: "Loading…",
  ready: "Ready",
  stale: "Showing last known data",
  unavailable: "Not available on this machine",
  auth: "Sign-in required",
  "rate-limited": "Rate limited; try again later",
  unsupported: "Not supported for this account",
  error: "Could not load usage",
};

export function modelLabel(key: string): string {
  if (key === OTHER_MODEL) return "Other";
  if (key === UNATTRIBUTED_MODEL) return "Unattributed";
  return key;
}

/** Theme-token series palette (light/dark aware); `Other` stays neutral. */
const SERIES_COLORS = [
  "var(--tool-info)",
  "var(--tool-agent)",
  "var(--tool-skill)",
  "var(--tool-execute)",
  "var(--tool-mutation)",
  "var(--tool-search)",
  "var(--tool-success)",
] as const;

export function seriesColor(key: string, index: number): string {
  if (key === OTHER_MODEL || key === UNATTRIBUTED_MODEL) return "var(--tool-neutral)";
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? "var(--tool-neutral)";
}

export function formatRelative(ms: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// Dates, months, weekdays and hours follow the system locale (`undefined`).

/** `YYYY-MM-DD` → localized short day, e.g. `Mar 4` / `4 мар.`. */
export function formatDayKey(key: string, locale?: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Localized full date, e.g. `Mar 4, 2026` / `4 мар. 2026 г.`. */
export function formatDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } };

/** Locale first day of week as `Date.getDay()` (0 = Sunday); Monday when unknown. */
export function localWeekStart(locale?: string): number {
  try {
    const tag = locale ?? new Intl.DateTimeFormat().resolvedOptions().locale;
    const info = new Intl.Locale(tag) as WeekInfoLocale;
    // Intl uses 1 = Monday … 7 = Sunday.
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7 ? firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

/** Localized short weekday names starting at `weekStart` (`Date.getDay()`, default Monday). */
export function weekdayLabels(locale?: string, weekStart = 1): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2024-01-07 is a Sunday.
  return Array.from({ length: 7 }, (_, row) => format.format(new Date(2024, 0, 7 + (weekStart + row) % 7)));
}

/** Localized short month name for a 0-based month. */
export function monthLabel(month: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2024, month, 1));
}

/** Localized local hour-of-day, e.g. `09:00` / `9:00 AM`. */
export function formatHour(hour: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(2024, 0, 1, hour));
}

/** Compact localized hour for axis ticks, e.g. `09` / `9 AM`. */
export function formatHourTick(hour: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2024, 0, 1, hour));
}

export function pathBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts[parts.length - 1] || path;
}
