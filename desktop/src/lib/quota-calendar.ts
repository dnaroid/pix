export interface QuotaCalendarDay {
  key: string;
  weekday: string;
  weekend: boolean;
  day: number;
  fullDate: string;
  today: boolean;
  reset: boolean;
}

/** Local civil dates, not 24-hour buckets: weeks must survive DST changes. */
export function quotaCalendarDays(resetAt: number, now: number): QuotaCalendarDay[] {
  const reset = new Date(resetAt);
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !Number.isFinite(reset.getTime())) return [];
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) return [];
  start.setHours(12, 0, 0, 0);
  const today = new Date(now).toDateString();
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
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
