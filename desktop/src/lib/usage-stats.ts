import type {
  UsageBucket,
  UsageSessionSummary,
  UsageSourceSnapshot,
  UsageValues,
} from "../../../acp/src/acp/usage-stats-contract";

/** Pure Desktop derivations over the Pix sessions usage snapshot. */

export type UsagePeriod = "7d" | "30d" | "90d" | "all";
export type UsageMetric = "tokens" | "cost" | "calls";
export type UsageScope = "project" | "all";

/** Model keys for buckets without a model and for collapsed tails. */
export const UNATTRIBUTED_MODEL = "\u0000unattributed";
export const OTHER_MODEL = "\u0000other";

const PERIOD_DAYS: Readonly<Record<Exclude<UsagePeriod, "all">, number>> = { "7d": 7, "30d": 30, "90d": 90 };
/** Upper bound for gap-filled day axes (`all` on long local histories). */
const MAX_AXIS_DAYS = 400;

export function metricValue(values: UsageValues, metric: UsageMetric): number {
  switch (metric) {
    case "tokens":
      return values.totalTokens ?? (values.input ?? 0) + (values.output ?? 0) + (values.cacheRead ?? 0) + (values.cacheWrite ?? 0);
    case "cost": return values.cost ?? 0;
    case "calls": return values.calls ?? 0;
  }
}

/** Metrics that carry data in a snapshot, in display preference order. */
export function availableMetrics(snapshot: UsageSourceSnapshot): UsageMetric[] {
  const order: UsageMetric[] = ["cost", "tokens", "calls"];
  return order.filter((metric) => snapshot.buckets.some((bucket) => metricValue(bucket.values, metric) > 0));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local calendar day of a bucket. */
export function bucketDayKey(bucket: UsageBucket): string {
  return localDayKey(bucket.startMs);
}

function localMidnight(ms: number, daysBack: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

export type UsagePeriodWindow = {
  /** Local midnight of the first day, or `null` for `all`. */
  fromMs: number | null;
  /** First included local calendar day (`YYYY-MM-DD`), or `null` for `all`. */
  fromKey: string | null;
  /** The source covers less than the requested period. */
  truncated: boolean;
};

export function periodWindow(period: UsagePeriod, nowMs: number, coverage: UsageSourceSnapshot["coverage"]): UsagePeriodWindow {
  if (period === "all") return { fromMs: null, fromKey: null, truncated: false };
  const fromMs = localMidnight(nowMs, PERIOD_DAYS[period] - 1);
  const fromKey = localDayKey(fromMs);
  return { fromMs, fromKey, truncated: coverage !== null && localDayKey(coverage.fromMs) > fromKey };
}

export function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/u, "");
  return trimmed.length > 0 ? trimmed : cwd;
}

export type UsageSelection = {
  period: UsagePeriod;
  nowMs: number;
  /** `null` = all models; otherwise a model key (see `modelKey`). */
  model?: string | null;
  scope?: UsageScope;
  cwd?: string;
  /** Keep `startMs: 0` (untimed) buckets; only honored for `all`. */
  includeUntimed?: boolean;
};

export function modelKey(bucket: UsageBucket): string {
  return bucket.model ?? UNATTRIBUTED_MODEL;
}

/** Buckets that fall into the period, model and project scope. */
export function selectBuckets(snapshot: UsageSourceSnapshot, selection: UsageSelection): UsageBucket[] {
  const window = periodWindow(selection.period, selection.nowMs, snapshot.coverage);
  const project = selection.scope === "project" && selection.cwd ? normalizeCwd(selection.cwd) : undefined;
  const nowKey = localDayKey(selection.nowMs);
  return snapshot.buckets.filter((bucket) => {
    if (selection.model != null && modelKey(bucket) !== selection.model) return false;
    if (project !== undefined && (bucket.projectCwd === undefined || normalizeCwd(bucket.projectCwd) !== project)) return false;
    if (bucket.startMs === 0) return window.fromKey === null && selection.includeUntimed === true;
    const day = bucketDayKey(bucket);
    return (window.fromKey === null || day >= window.fromKey) && day <= nowKey;
  });
}

export type UsageTimeFilter = {
  /** Local calendar day (`YYYY-MM-DD`). */
  day?: string | null;
  /** Local hour of day, 0–23. */
  hour?: number | null;
};

/** Narrow buckets to a local day and/or hour of day; untimed buckets drop out once filtered. */
export function filterByTime(buckets: readonly UsageBucket[], filter: UsageTimeFilter): UsageBucket[] {
  const day = filter.day ?? null;
  const hour = filter.hour ?? null;
  if (day === null && hour === null) return [...buckets];
  return buckets.filter((bucket) => {
    if (bucket.startMs === 0) return false;
    if (day !== null && bucketDayKey(bucket) !== day) return false;
    if (hour !== null && (bucket.width !== "hour" || new Date(bucket.startMs).getHours() !== hour)) return false;
    return true;
  });
}

export function sumValues(buckets: readonly UsageBucket[]): UsageValues {
  const total: UsageValues = {};
  for (const { values } of buckets) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "calls", "cost"] as const) {
      const value = values[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
    if (values.costEstimated) total.costEstimated = true;
  }
  return total;
}

export type UsageModelOption = { key: string; label: string | null; value: number };

/** Distinct models, largest first (`label: null` = Unattributed). */
export function modelOptions(snapshot: UsageSourceSnapshot, metric: UsageMetric): UsageModelOption[] {
  const totals = new Map<string, number>();
  for (const bucket of snapshot.buckets) {
    const key = modelKey(bucket);
    totals.set(key, (totals.get(key) ?? 0) + metricValue(bucket.values, metric));
  }
  return [...totals].map(([key, value]) => ({ key, label: key === UNATTRIBUTED_MODEL ? null : key, value }))
    .sort((a, b) => b.value - a.value || (a.label ?? "").localeCompare(b.label ?? ""));
}

/** `outside`: padding day before the window or after today; drawn faint, never counted. */
export type UsageCalendarDay = { key: string; value: number; outside?: true };
export type UsageCalendar = {
  /** Whole week columns starting on `weekStart`; days outside the window are `outside`. */
  weeks: (UsageCalendarDay | null)[][];
  /** First weekday of each column, as `Date.getDay()` (0 = Sunday). */
  weekStart: number;
  max: number;
  total: number;
};

/** GitHub-style days of the last year at most (53 weeks). */
const CALENDAR_MAX_DAYS = 371;

function shiftDayKey(dayKey: string, offset: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return localDayKey(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offset).getTime());
}

/** Calendar window of the current local week, starting on `weekStart` (`Date.getDay()`). */
export function currentWeekWindow(nowMs: number, weekStart: number): UsagePeriodWindow {
  const fromMs = localMidnight(nowMs, (new Date(nowMs).getDay() - weekStart + 7) % 7);
  return { fromMs, fromKey: localDayKey(fromMs), truncated: false };
}

function weekdayOffset(dayKey: string, weekStart: number): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return (new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay() - weekStart + 7) % 7;
}

/** Per-day calendar (weeks × weekday) from timed buckets of any width. */
export function calendarHeatmap(
  buckets: readonly UsageBucket[],
  metric: UsageMetric,
  window: UsagePeriodWindow,
  nowMs: number,
  /** Locale first day of week, as `Date.getDay()`; defaults to Monday. */
  weekStart = 1,
): UsageCalendar {
  const timed = buckets.filter((bucket) => bucket.startMs !== 0);
  const firstKey = window.fromKey ?? timed.reduce<string | null>((min, bucket) => {
    const key = bucketDayKey(bucket);
    return min === null || key < min ? key : min;
  }, null);
  if (firstKey === null) return { weeks: [], weekStart, max: 0, total: 0 };
  const days = dayKeysBetween(firstKey, localDayKey(nowMs)).slice(-CALENDAR_MAX_DAYS);
  const values = new Map(days.map((day) => [day, 0]));
  let total = 0;
  for (const bucket of timed) {
    const key = bucketDayKey(bucket);
    const current = values.get(key);
    if (current === undefined) continue;
    const value = metricValue(bucket.values, metric);
    values.set(key, current + value);
    total += value;
  }
  const cells: (UsageCalendarDay | null)[] = [];
  if (days.length > 0) {
    const lead = weekdayOffset(days[0]!, weekStart);
    for (let offset = lead; offset > 0; offset -= 1) cells.push({ key: shiftDayKey(days[0]!, -offset), value: 0, outside: true });
  }
  for (const day of days) cells.push({ key: day, value: values.get(day) ?? 0 });
  for (let offset = 1; cells.length % 7 !== 0; offset += 1) cells.push({ key: shiftDayKey(days[days.length - 1]!, offset), value: 0, outside: true });
  const weeks: (UsageCalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const max = [...values.values()].reduce((best, value) => Math.max(best, value), 0);
  return { weeks, weekStart, max, total };
}

export type UsageHourProfile = { hours: number[]; max: number; total: number };

/** Local hour-of-day totals from hourly buckets only; `null` without hourly data. */
export function hourOfDayProfile(buckets: readonly UsageBucket[], metric: UsageMetric): UsageHourProfile | null {
  const hours = new Array<number>(24).fill(0);
  let hourly = false;
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.width !== "hour" || bucket.startMs === 0) continue;
    hourly = true;
    const value = metricValue(bucket.values, metric);
    if (value <= 0) continue;
    const hour = new Date(bucket.startMs).getHours();
    hours[hour] = (hours[hour] ?? 0) + value;
    total += value;
  }
  return hourly ? { hours, max: Math.max(...hours), total } : null;
}

/** Inclusive local day keys from `fromKey` to `toKey`, capped at `MAX_AXIS_DAYS`. */
export function dayKeysBetween(fromKey: string, toKey: string): string[] {
  const [y, m, d] = fromKey.split("-").map(Number);
  const keys: string[] = [];
  for (let offset = 0; keys.length < MAX_AXIS_DAYS; offset += 1) {
    const key = localDayKey(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offset).getTime());
    if (key > toKey) break;
    keys.push(key);
  }
  return keys.length === MAX_AXIS_DAYS ? keys.slice(-MAX_AXIS_DAYS) : keys;
}

export type UsageDailySeries = {
  days: string[];
  /** Model keys in stacking order (largest first; `OTHER_MODEL` last). */
  models: string[];
  /** `values[dayIndex][modelIndex]`. */
  values: number[][];
  max: number;
};

/** Per-day totals stacked by the top `maxModels` models; the tail becomes `OTHER_MODEL`. */
export function dailyByModel(
  buckets: readonly UsageBucket[],
  metric: UsageMetric,
  window: UsagePeriodWindow,
  nowMs: number,
  maxModels = 5,
): UsageDailySeries {
  const timed = buckets.filter((bucket) => bucket.startMs !== 0);
  const shares = collapse(groupTotals(timed, modelKey, metric), maxModels);
  const keep = new Set(shares.map((share) => share.key));
  const models = shares.map((share) => share.key);
  const nowKey = localDayKey(nowMs);
  const firstKey = window.fromKey ?? timed.reduce<string | null>((min, bucket) => {
    const key = bucketDayKey(bucket);
    return min === null || key < min ? key : min;
  }, null);
  const days = firstKey === null ? [] : dayKeysBetween(firstKey, nowKey);
  const index = new Map(days.map((day, i) => [day, i]));
  const values = days.map(() => new Array<number>(models.length).fill(0));
  for (const bucket of timed) {
    const row = values[index.get(bucketDayKey(bucket)) ?? -1];
    if (!row) continue;
    const key = keep.has(modelKey(bucket)) ? modelKey(bucket) : OTHER_MODEL;
    const column = models.indexOf(key);
    if (column >= 0) row[column] = (row[column] ?? 0) + metricValue(bucket.values, metric);
  }
  const max = values.reduce((best, row) => Math.max(best, row.reduce((sum, value) => sum + value, 0)), 0);
  return { days, models, values, max };
}

export type UsageShare = { key: string; value: number; share: number };

function groupTotals(buckets: readonly UsageBucket[], keyOf: (bucket: UsageBucket) => string | undefined, metric: UsageMetric): UsageShare[] {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    const key = keyOf(bucket);
    if (key === undefined) continue;
    const value = metricValue(bucket.values, metric);
    if (value > 0) totals.set(key, (totals.get(key) ?? 0) + value);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals].map(([key, value]) => ({ key, value, share: sum > 0 ? value / sum : 0 }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

function collapse(shares: UsageShare[], max: number): UsageShare[] {
  if (shares.length <= max) return shares;
  const head = shares.slice(0, Math.max(1, max - 1));
  const tail = shares.slice(head.length);
  return [...head, {
    key: OTHER_MODEL,
    value: tail.reduce((sum, share) => sum + share.value, 0),
    share: tail.reduce((sum, share) => sum + share.share, 0),
  }];
}

/** Share by model; at most `maxModels` entries including `OTHER_MODEL`. */
export function modelShares(buckets: readonly UsageBucket[], metric: UsageMetric, maxModels = 6): UsageShare[] {
  return collapse(groupTotals(buckets, modelKey, metric), maxModels);
}

export type UsageCacheEfficiency = { hitRate: number; cacheRead: number; prompt: number };

/** `cacheRead / (input + cacheRead + cacheWrite)`; `null` when no prompt tokens are known. */
export function cacheEfficiency(values: UsageValues): UsageCacheEfficiency | null {
  const cacheRead = values.cacheRead ?? 0;
  const prompt = (values.input ?? 0) + cacheRead + (values.cacheWrite ?? 0);
  return prompt > 0 ? { hitRate: cacheRead / prompt, cacheRead, prompt } : null;
}

/** A usage session to open. `sessionId` is the Pi header id, which differs
 * from the Desktop/ACP id of sessions created by Desktop. */
export type UsageSessionTarget = { sessionId: string; sessionFile?: string };

/** Resolve the ACP session id of a usage session: by session file first, then by id. */
export function resolveUsageSessionId(
  target: UsageSessionTarget,
  sessions: readonly { sessionId: string; _meta?: { [key: string]: unknown } | null }[],
): string | null {
  if (target.sessionFile) {
    const byFile = sessions.find((session) => session._meta?.["pix.sessionFile"] === target.sessionFile);
    if (byFile) return byFile.sessionId;
  }
  return sessions.some((session) => session.sessionId === target.sessionId) ? target.sessionId : null;
}

export type UsageTopSession = {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  projectCwd?: string;
  lastAtMs?: number;
  userTurns?: number;
  values: UsageValues;
  value: number;
};

/** Largest sessions by `metric` within the selected buckets. */
export function topSessions(
  buckets: readonly UsageBucket[],
  sessions: readonly UsageSessionSummary[] | undefined,
  metric: UsageMetric,
  limit = 10,
): UsageTopSession[] {
  const grouped = new Map<string, UsageBucket[]>();
  for (const bucket of buckets) {
    if (!bucket.sessionId) continue;
    const list = grouped.get(bucket.sessionId);
    if (list) list.push(bucket);
    else grouped.set(bucket.sessionId, [bucket]);
  }
  const summaries = new Map((sessions ?? []).map((summary) => [summary.sessionId, summary]));
  return [...grouped].map(([sessionId, list]): UsageTopSession => {
    const values = sumValues(list);
    const summary = summaries.get(sessionId);
    // Last activity within the selection, not the session's global last activity.
    const lastBucketEnd = list.reduce((max, bucket) => bucket.startMs === 0 ? max
      : Math.max(max, bucket.startMs + (bucket.width === "day" ? 86_400_000 : 3_600_000) - 1), 0);
    const lastAtMs = lastBucketEnd > 0 ? Math.min(lastBucketEnd, summary?.lastAtMs ?? lastBucketEnd) : undefined;
    return {
      sessionId,
      values,
      value: metricValue(values, metric),
      ...(summary?.sessionFile !== undefined ? { sessionFile: summary.sessionFile } : {}),
      ...(summary?.name !== undefined ? { name: summary.name } : {}),
      ...(summary?.projectCwd !== undefined ? { projectCwd: summary.projectCwd } : {}),
      ...(lastAtMs !== undefined ? { lastAtMs } : {}),
      ...(summary ? { userTurns: summary.userTurns } : {}),
    };
  }).filter((session) => session.value > 0)
    .sort((a, b) => b.value - a.value || (b.lastAtMs ?? 0) - (a.lastAtMs ?? 0))
    .slice(0, limit);
}

/** Whether a snapshot has anything worth charting. */
export function hasUsageData(snapshot: UsageSourceSnapshot | undefined): snapshot is UsageSourceSnapshot {
  return snapshot !== undefined && snapshot.buckets.some((bucket) =>
    Object.values(bucket.values).some((value) => typeof value === "number" && value > 0));
}
