import { describe, expect, it } from "vitest";
import { parseUsageStatsChangedNotification, parseUsageStatsResponse } from "./usage-stats-parser";

const snapshot = {
  source: "pix-sessions",
  status: "ready",
  unit: "tokens",
  coverage: { fromMs: 1, toMs: 2 },
  fetchedAtMs: 3,
  skippedFiles: 0,
  untimedRecords: 1,
  message: "ok",
  buckets: [
    { startMs: 0, width: "day", provider: null, model: null, values: { input: 5, costEstimated: true, extra: "ignored" } },
    { startMs: 3_600_000, width: "hour", provider: "anthropic", model: "claude", sessionId: "s", projectCwd: "/p", values: { output: 2, cost: 0.1 } },
  ],
  sessions: [{ sessionId: "s", name: "Name", userTurns: 2, firstAtMs: 1, lastAtMs: 2 }],
};

describe("usage stats parser", () => {
  it("keeps valid snapshots and drops unknown value keys", () => {
    const parsed = parseUsageStatsResponse({ snapshots: [snapshot] });
    expect(parsed.snapshots).toHaveLength(1);
    const [first] = parsed.snapshots;
    expect(first?.buckets[0]?.values).toEqual({ input: 5, costEstimated: true });
    expect(first?.buckets[1]).toMatchObject({ sessionId: "s", projectCwd: "/p" });
    expect(first?.sessions).toEqual([{ sessionId: "s", name: "Name", userTurns: 2, firstAtMs: 1, lastAtMs: 2 }]);
    expect(first).toMatchObject({ coverage: { fromMs: 1, toMs: 2 }, skippedFiles: 0, untimedRecords: 1, message: "ok" });
  });

  it("skips unknown sources for forward compatibility", () => {
    expect(parseUsageStatsResponse({ snapshots: [{ ...snapshot, source: "future-source" }, snapshot] }).snapshots.map((s) => s.source)).toEqual(["pix-sessions"]);
  });

  it("rejects malformed responses", () => {
    const bad = [
      null,
      { snapshots: "x" },
      { snapshots: [1] },
      { snapshots: [{ ...snapshot, status: "weird" }] },
      { snapshots: [{ ...snapshot, unit: "dollars" }] },
      { snapshots: [{ ...snapshot, coverage: { fromMs: -1, toMs: 2 } }] },
      { snapshots: [{ ...snapshot, buckets: [{ ...snapshot.buckets[0], width: "week" }] }] },
      { snapshots: [{ ...snapshot, buckets: [{ ...snapshot.buckets[0], values: { input: Number.NaN } }] }] },
      { snapshots: [{ ...snapshot, unit: "quota-percent" }] },
      { snapshots: [{ ...snapshot, sessions: [{ sessionId: "s" }] }] },
    ];
    for (const value of bad) expect(() => parseUsageStatsResponse(value)).toThrow("pix/usage/stats returned an invalid response");
  });

  it("parses change notifications", () => {
    expect(parseUsageStatsChangedNotification({ source: "pix-sessions" })).toEqual({ source: "pix-sessions" });
    expect(parseUsageStatsChangedNotification({ source: "pix-sessions", cwd: "/w" })).toEqual({ source: "pix-sessions" });
    expect(parseUsageStatsChangedNotification({ source: "codex-local" })).toBeUndefined();
    expect(parseUsageStatsChangedNotification(null)).toBeUndefined();
  });
});
