import type { ModelUsageLimitWindow } from "./acp-client";
import { clampUsagePercent } from "./runtime-status";

export interface QuotaCycleTick {
  at: number;
  position: number;
  label: string;
  fullDate: string;
}

/** One reported window, left-to-right. Never predict the next reset. */
export function quotaCycleTimeline(window: ModelUsageLimitWindow, now: number): {
  ticks: QuotaCycleTick[];
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
  return { ticks, timePosition: clampUsagePercent((now - start) / duration * 100) };
}
