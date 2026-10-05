export interface QuotaCalendarDay {
  key: string;
  weekday: string;
  weekend: boolean;
  day: number;
  fullDate: string;
  today: boolean;
  reset: boolean;
}

/** A civil week plus the reported reset, bounded to eight dates even for distant resets. */
export function quotaCalendarDays(resetAt: number, now: number): QuotaCalendarDay[] {
  const reset = new Date(resetAt);
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !Number.isFinite(reset.getTime())) return [];
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) return [];
  start.setHours(12, 0, 0, 0);
  const today = new Date(now).toDateString();
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  if (!dates.some(date => date.toDateString() === reset.toDateString())) {
    const resetDay = new Date(reset);
    resetDay.setHours(12, 0, 0, 0);
    dates.push(resetDay);
    dates.sort((a, b) => a.getTime() - b.getTime());
  }
  return dates.map(date => {
    return {
      key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
      weekend: date.getDay() === 0 || date.getDay() === 6,
      day: date.getDate(),
      fullDate: date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
      today: date.toDateString() === today,
      reset: date.toDateString() === reset.toDateString(),
    };
  });
}
