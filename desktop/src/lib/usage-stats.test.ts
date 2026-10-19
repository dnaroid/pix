import { describe, expect, it } from "vitest";
import type { UsageBucket, UsageSourceSnapshot } from "../../../acp/src/acp/usage-stats-contract";
import {
  OTHER_MODEL,
  UNATTRIBUTED_MODEL,
  availableMetrics,
  bucketDayKey,
  cacheEfficiency,
  dailyByModel,
  currentWeekWindow,
  dayKeysBetween,
  filterByTime,
  resolveUsageSessionId,
  hasUsageData,
  localDayKey,
  metricValue,
  modelOptions,
  modelShares,
  periodWindow,
  selectBuckets,
  sumValues,
  topSessions,
  calendarHeatmap,
  hourOfDayProfile,
} from "./usage-stats";

// Local wall-clock helpers keep assertions time-zone independent.
const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
const NOW = local(2026, 10, 17, 15);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return { startMs: local(2026, 10, 17, 10), width: "hour", provider: "anthropic", model: "opus", values: { totalTokens: 10 }, ...overrides };
}

function snapshot(buckets: UsageBucket[], overrides: Partial<UsageSourceSnapshot> = {}): UsageSourceSnapshot {
  return { source: "pix-sessions", status: "ready", unit: "tokens", coverage: null, buckets, fetchedAtMs: NOW, ...overrides };
}

describe("usage stats derivations", () => {
  it("computes metric values without double counting", () => {
    expect(metricValue({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 100 }, "tokens")).toBe(10);
    expect(metricValue({ totalTokens: 7, input: 1 }, "tokens")).toBe(7);
    expect(metricValue({ cost: 0.5 }, "cost")).toBe(0.5);
    expect(metricValue({}, "calls")).toBe(0);
  });

  it("lists only metrics that carry data", () => {
    expect(availableMetrics(snapshot([bucket({ values: { totalTokens: 5, cost: 1 } })]))).toEqual(["cost", "tokens"]);
    expect(availableMetrics(snapshot([bucket({ values: { calls: 3 } })]))).toEqual(["calls"]);
  });

  it("keys buckets by local day", () => {
    expect(bucketDayKey(bucket({ startMs: local(2026, 10, 17, 23) }))).toBe("2026-10-17");
    expect(bucketDayKey(bucket({ startMs: local(2026, 10, 18, 0) }))).toBe("2026-10-18");
  });

  it("filters by local day and hour of day, dropping untimed buckets", () => {
    const morning = bucket({ startMs: local(2026, 10, 17, 9) });
    const evening = bucket({ startMs: local(2026, 10, 17, 21) });
    const yesterday = bucket({ startMs: local(2026, 10, 16, 9) });
    const daily = bucket({ startMs: local(2026, 10, 17), width: "day" });
    const untimed = bucket({ startMs: 0 });
    const all = [morning, evening, yesterday, daily, untimed];
    expect(filterByTime(all, {})).toEqual(all);
    expect(filterByTime(all, {})).not.toBe(all);
    expect(filterByTime(all, { day: "2026-10-17" })).toEqual([morning, evening, daily]);
    expect(filterByTime(all, { hour: 9 })).toEqual([morning, yesterday]);
    expect(filterByTime(all, { day: "2026-10-17", hour: 9 })).toEqual([morning]);
    expect(filterByTime(all, { day: "2026-10-01" })).toEqual([]);
  });

  it("clamps periods and flags truncated coverage", () => {
    const week = periodWindow("7d", NOW, null);
    expect(week).toEqual({ fromMs: local(2026, 10, 11), fromKey: "2026-10-11", truncated: false });
    expect(periodWindow("30d", NOW, { fromMs: local(2026, 10, 10), toMs: NOW }).truncated).toBe(true);
    expect(periodWindow("7d", NOW, { fromMs: local(2026, 10, 1), toMs: NOW }).truncated).toBe(false);
    expect(periodWindow("all", NOW, { fromMs: 1, toMs: NOW })).toEqual({ fromMs: null, fromKey: null, truncated: false });
  });

  it("selects by period, model, project scope and untimed policy", () => {
    const data = snapshot([
      bucket({ startMs: local(2026, 10, 11, 0), projectCwd: "/w/a/" }),
      bucket({ startMs: local(2026, 10, 10, 23), projectCwd: "/w/a" }),
      bucket({ model: null, projectCwd: "/w/b" }),
      bucket({ startMs: 0 }),
    ]);
    expect(selectBuckets(data, { period: "7d", nowMs: NOW })).toHaveLength(2);
    expect(selectBuckets(data, { period: "all", nowMs: NOW })).toHaveLength(3);
    expect(selectBuckets(data, { period: "all", nowMs: NOW, includeUntimed: true })).toHaveLength(4);
    expect(selectBuckets(data, { period: "all", nowMs: NOW, scope: "all", cwd: "/w/a" })).toHaveLength(3);
    expect(selectBuckets(data, { period: "7d", nowMs: NOW, includeUntimed: true })).toHaveLength(2);
    expect(selectBuckets(data, { period: "all", nowMs: NOW, scope: "project", cwd: "/w/a" })).toHaveLength(2);
    expect(selectBuckets(data, { period: "all", nowMs: NOW, model: UNATTRIBUTED_MODEL })).toHaveLength(1);
  });

  it("sums values and propagates estimated cost", () => {
    expect(sumValues([bucket({ values: { input: 1, cost: 1 } }), bucket({ values: { input: 2, cost: 2, costEstimated: true } })]))
      .toEqual({ input: 3, cost: 3, costEstimated: true });
  });

  it("orders model options by metric with Unattributed labelled null", () => {
    const options = modelOptions(snapshot([
      bucket({ model: "a", values: { totalTokens: 1 } }),
      bucket({ model: "b", values: { totalTokens: 5 } }),
      bucket({ model: null, values: { totalTokens: 3 } }),
    ]), "tokens");
    expect(options).toEqual([
      { key: "b", label: "b", value: 5 },
      { key: UNATTRIBUTED_MODEL, label: null, value: 3 },
      { key: "a", label: "a", value: 1 },
    ]);
  });

  it("builds a Monday-first calendar of local days, padded to whole weeks", () => {
    // 2026-10-17 is a Saturday; the 7d window starts Sunday 2026-10-11.
    const window = periodWindow("7d", NOW, null);
    const calendar = calendarHeatmap([
      bucket({ startMs: local(2026, 10, 17, 9), values: { totalTokens: 4 } }),
      bucket({ startMs: local(2026, 10, 17, 23), values: { totalTokens: 2 } }),
      bucket({ startMs: local(2026, 10, 12, 0), values: { totalTokens: 1 } }),
      bucket({ startMs: local(2026, 9, 1, 0), values: { totalTokens: 99 } }),
      bucket({ startMs: 0, values: { totalTokens: 50 } }),
    ], "tokens", window, NOW);
    expect(calendar.weeks).toHaveLength(2);
    expect(calendar.weeks[0]![0]).toEqual({ key: "2026-10-05", value: 0, outside: true });
    expect(calendar.weeks[0]!.slice(0, 6).every((day) => day?.outside === true)).toBe(true);
    expect(calendar.weeks[0]![6]).toEqual({ key: "2026-10-11", value: 0 });
    expect(calendar.weeks[1]![0]).toEqual({ key: "2026-10-12", value: 1 });
    expect(calendar.weeks[1]![5]).toEqual({ key: "2026-10-17", value: 6 });
    expect(calendar.weeks[1]![6]).toEqual({ key: "2026-10-18", value: 0, outside: true });
    expect(calendar.weeks.flat().every((day) => day !== null)).toBe(true);
    expect(calendar).toMatchObject({ max: 6, total: 7, weekStart: 1 });
  });

  it("aligns the current-week window to the locale week start", () => {
    // NOW is Saturday 2026-10-17.
    expect(currentWeekWindow(NOW, 1)).toEqual({ fromMs: local(2026, 10, 12), fromKey: "2026-10-12", truncated: false });
    expect(currentWeekWindow(NOW, 0)).toMatchObject({ fromKey: "2026-10-11" });
    expect(currentWeekWindow(NOW, 6)).toMatchObject({ fromKey: "2026-10-17" });
    const week = calendarHeatmap([bucket({ startMs: local(2026, 10, 12, 9) })], "tokens", currentWeekWindow(NOW, 1), NOW, 1);
    expect(week.weeks).toHaveLength(1);
    expect(week.weeks[0]![0]).toEqual({ key: "2026-10-12", value: 10 });
    expect(week.weeks[0]![6]).toEqual({ key: "2026-10-18", value: 0, outside: true });
  });

  it("colors neighboring days with real activity without counting them in period totals", () => {
    const calendar = calendarHeatmap([
      bucket({ startMs: local(2026, 10, 4), values: { totalTokens: 500 } }), // Before the first column.
      bucket({ startMs: local(2026, 10, 10, 9), values: { totalTokens: 20 } }),
      bucket({ startMs: local(2026, 10, 10, 10), values: { totalTokens: 10 } }),
      bucket({ startMs: local(2026, 10, 17, 9), values: { totalTokens: 5 } }),
      bucket({ startMs: local(2026, 10, 18, 9), values: { totalTokens: 500 } }), // Future padding.
    ], "tokens", periodWindow("7d", NOW, null), NOW, 1);
    expect(calendar.weeks[0]![5]).toEqual({ key: "2026-10-10", value: 30, outside: true });
    expect(calendar.weeks[1]![6]).toEqual({ key: "2026-10-18", value: 0, outside: true });
    expect(calendar).toMatchObject({ max: 30, total: 5 });
  });

  it("keeps scope, model and hour filters on contextual calendar activity", () => {
    const context = { startMs: local(2026, 10, 10, 9), model: "a", projectCwd: "/w/a" };
    const data = snapshot([
      bucket({ ...context, values: { totalTokens: 20 } }),
      bucket({ ...context, projectCwd: "/w/b", values: { totalTokens: 1000 } }),
      bucket({ ...context, model: "b", values: { totalTokens: 1000 } }),
      bucket({ ...context, startMs: local(2026, 10, 10, 10), values: { totalTokens: 1000 } }),
      bucket({ ...context, startMs: local(2026, 10, 17, 9), values: { totalTokens: 5 } }),
    ]);
    const history = filterByTime(selectBuckets(data, {
      period: "all", nowMs: NOW, scope: "project", cwd: "/w/a", model: "a",
    }), { hour: 9 });
    const calendar = calendarHeatmap(history, "tokens", periodWindow("7d", NOW, null), NOW, 1);
    expect(calendar.weeks[0]![5]).toMatchObject({ value: 20, outside: true });
    expect(calendar).toMatchObject({ max: 20, total: 5 });
  });

  it("starts calendar weeks on the locale first day", () => {
    const window = periodWindow("7d", NOW, null);
    const sunday = calendarHeatmap([bucket({ startMs: local(2026, 10, 17, 9) })], "tokens", window, NOW, 0);
    // Sunday 2026-10-11 … Saturday 2026-10-17 fill exactly one week.
    expect(sunday.weeks).toHaveLength(1);
    expect(sunday.weeks[0]![0]).toEqual({ key: "2026-10-11", value: 0 });
    expect(sunday.weeks[0]![6]).toEqual({ key: "2026-10-17", value: 10 });
    const saturday = calendarHeatmap([], "tokens", window, NOW, 6);
    expect(saturday.weeks[0]![0]).toEqual({ key: "2026-10-10", value: 0, outside: true });
    expect(saturday.weeks[0]![1]).toEqual({ key: "2026-10-11", value: 0 });
    expect(saturday.weeks[1]![0]).toEqual({ key: "2026-10-17", value: 0 });
  });

  it("caps the all-time calendar at 53 weeks", () => {
    const calendar = calendarHeatmap([bucket({ startMs: local(2023, 1, 1, 12) })], "tokens", periodWindow("all", NOW, null), NOW);
    expect(calendar.weeks.length).toBeLessThanOrEqual(54);
    expect(calendar.total).toBe(0);
  });

  it("profiles local hours of day from hourly buckets only", () => {
    const profile = hourOfDayProfile([
      bucket({ startMs: local(2026, 10, 17, 9), values: { totalTokens: 4 } }),
      bucket({ startMs: local(2026, 10, 12, 9), values: { totalTokens: 2 } }),
      bucket({ startMs: 0, values: { totalTokens: 50 } }),
    ], "tokens");
    expect(profile?.hours[9]).toBe(6);
    expect(profile).toMatchObject({ max: 6, total: 6 });
    expect(hourOfDayProfile([bucket({ width: "day" })], "tokens")).toBeNull();
  });

  it("generates bounded gap-free day axes across month ends", () => {
    expect(dayKeysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(dayKeysBetween("2020-01-01", "2026-10-17")).toHaveLength(400);
    expect(localDayKey(local(2026, 3, 29, 12))).toBe("2026-03-29");
  });

  it("stacks per-day totals by the top models and collapses the tail", () => {
    const window = periodWindow("7d", NOW, null);
    const series = dailyByModel([
      bucket({ model: "a", startMs: local(2026, 10, 16, 1), values: { totalTokens: 10 } }),
      bucket({ model: "b", startMs: local(2026, 10, 17, 1), values: { totalTokens: 5 } }),
      bucket({ model: "c", startMs: local(2026, 10, 17, 2), values: { totalTokens: 1 } }),
      bucket({ model: "d", startMs: local(2026, 10, 17, 3), values: { totalTokens: 1 } }),
    ], "tokens", window, NOW, 3);
    expect(series.days).toHaveLength(7);
    expect(series.models).toEqual(["a", "b", OTHER_MODEL]);
    expect(series.values[5]).toEqual([10, 0, 0]);
    expect(series.values[6]).toEqual([0, 5, 2]);
    expect(series.max).toBe(10);

    const all = dailyByModel([bucket({ startMs: local(2026, 10, 15, 1) })], "tokens", periodWindow("all", NOW, null), NOW);
    expect(all.days).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(dailyByModel([], "tokens", periodWindow("all", NOW, null), NOW).days).toEqual([]);
  });

  it("computes model shares", () => {
    const shares = modelShares([bucket({ model: "a", values: { totalTokens: 3 } }), bucket({ model: "b", values: { totalTokens: 1 } })], "tokens");
    expect(shares).toEqual([{ key: "a", value: 3, share: 0.75 }, { key: "b", value: 1, share: 0.25 }]);
  });

  it("computes cache hit rate only with known prompt tokens", () => {
    expect(cacheEfficiency({ input: 10, cacheRead: 30, cacheWrite: 10 })).toEqual({ hitRate: 0.6, cacheRead: 30, prompt: 50 });
    expect(cacheEfficiency({ output: 5 })).toBeNull();
  });

  it("ranks top sessions and joins summaries", () => {
    const top = topSessions([
      bucket({ sessionId: "s1", values: { totalTokens: 5 } }),
      bucket({ sessionId: "s1", values: { totalTokens: 5 } }),
      bucket({ sessionId: "s2", values: { totalTokens: 20 } }),
      bucket({ sessionId: "s3", values: { totalTokens: 0 } }),
      bucket({ values: { totalTokens: 99 } }),
    ], [{ sessionId: "s1", name: "First", userTurns: 2, lastAtMs: 5 }], "tokens");
    expect(top.map((session) => [session.sessionId, session.value])).toEqual([["s2", 20], ["s1", 10]]);
    expect(top[1]).toMatchObject({ name: "First", userTurns: 2 });
  });

  it("dates top sessions by their last activity inside the selection", () => {
    const [session] = topSessions([
      bucket({ sessionId: "s1", startMs: local(2026, 10, 12, 9), values: { totalTokens: 5 } }),
    ], [{ sessionId: "s1", userTurns: 1, lastAtMs: local(2026, 10, 17, 14) }], "tokens");
    expect(session!.lastAtMs).toBe(local(2026, 10, 12, 10) - 1);
    const [current] = topSessions([
      bucket({ sessionId: "s1", startMs: local(2026, 10, 17, 14), values: { totalTokens: 5 } }),
    ], [{ sessionId: "s1", userTurns: 1, lastAtMs: local(2026, 10, 17, 14) + 60_000 }], "tokens");
    expect(current!.lastAtMs).toBe(local(2026, 10, 17, 14) + 60_000);
  });

  it("detects whether a snapshot has chartable data", () => {
    expect(hasUsageData(undefined)).toBe(false);
    expect(hasUsageData(snapshot([]))).toBe(false);
    expect(hasUsageData(snapshot([bucket({ values: { totalTokens: 0 } })]))).toBe(false);
    expect(hasUsageData(snapshot([bucket()]))).toBe(true);
  });
});

describe("resolveUsageSessionId", () => {
  const catalog = [
    { sessionId: "acp-1", _meta: { "pix.sessionFile": "/s/a.jsonl" } },
    { sessionId: "pi-b", _meta: { "pix.sessionFile": "/s/b.jsonl" } },
  ];
  it("maps a Pi header id to the ACP id by session file", () => {
    expect(resolveUsageSessionId({ sessionId: "pi-a", sessionFile: "/s/a.jsonl" }, catalog)).toBe("acp-1");
  });
  it("falls back to an identical id and returns null when unknown", () => {
    expect(resolveUsageSessionId({ sessionId: "pi-b" }, catalog)).toBe("pi-b");
    expect(resolveUsageSessionId({ sessionId: "pi-x", sessionFile: "/s/x.jsonl" }, catalog)).toBeNull();
  });
});
