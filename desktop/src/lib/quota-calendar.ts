import type { ModelUsageLimitWindow } from "./acp-client";
import { clampUsagePercent } from "./runtime-status";

export interface QuotaCycleTick {
  at: number;
  position: number;
  label: string;
  fullDate: string;
}

export interface QuotaCycleDay {
  weekday: string;
  day: number;
  fullDate: string;
  weekend: boolean;
  /** Share of the window (0..1) where this calendar day starts/ends. */
  startFraction: number;
  endFraction: number;
}

/** One reported window, left-to-right. Never predict the next reset. */
export function quotaCycleTimeline(window: ModelUsageLimitWindow, now: number): {
  ticks: QuotaCycleTick[];
  days: QuotaCycleDay[];
  timePosition: number;
} | null {
  const duration = window.windowSeconds * 1000;
  const start = window.resetAt - duration;
  if (!window.hasKnownWindowDuration || !Number.isFinite(duration) || duration <= 0
    || window.resetAt <= 0 || !Number.isFinite(new Date(window.resetAt).getTime())
    || !Number.isFinite(new Date(start).getTime()) || !Number.isFinite(now)) return null;

  const ticks = Array.from({ length: 8 }, (_, index) => {
    const at = start + duration * index / 7;
    const date = new Date(at);
    const previous = new Date(start + duration * (index - 1) / 7);
    const showMonth = index === 0 || date.getMonth() !== previous.getMonth()
      || date.getFullYear() !== previous.getFullYear();
    return {
      at,
      position: index * 100 / 7,
      label: date.toLocaleDateString(undefined, { day: "numeric", ...(showMonth ? { month: "short" } : {}) }),
      fullDate: date.toLocaleString(undefined, {
        year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
      }),
    };
  });
  // Calendar-day segments: the first and last are partial, so labels, pin and
  // fill all share one time axis and the pin always sits under its date.
  const days: QuotaCycleDay[] = [];
  const end = window.resetAt;
  const first = new Date(start);
  for (let k = 0; ; k++) {
    const midnight = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k);
    const next = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k + 1);
    if (midnight.getTime() >= end || k > 31) break;
    const segStart = Math.max(start, midnight.getTime());
    const segEnd = Math.min(end, next.getTime());
    if (segEnd <= segStart) continue;
    days.push({
      weekday: midnight.toLocaleDateString(undefined, { weekday: "short" }),
      day: midnight.getDate(),
      weekend: midnight.getDay() === 0 || midnight.getDay() === 6,
      fullDate: midnight.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
      startFraction: (segStart - start) / duration,
      endFraction: (segEnd - start) / duration,
    });
  }
  return { ticks, days, timePosition: clampUsagePercent((now - start) / duration * 100) };
}
