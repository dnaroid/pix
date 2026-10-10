import { describe, expect, it } from "vitest";
import { quotaCycleTimeline } from "./quota-calendar";

const resetAt = new Date(2026, 9, 14, 10, 12).getTime();
const window = { remainingPercent: 57, resetAt, windowSeconds: 604_800, hasKnownWindowDuration: true };
const day = 86_400_000;

describe("quota cycle timeline", () => {
  it("anchors eight ticks to the actual start and reset, not today", () => {
    const timeline = quotaCycleTimeline(window, resetAt - 4 * day)!;
    expect(timeline.ticks.map(tick => new Date(tick.at).getDate())).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    expect(timeline.ticks[0]!.at).toBe(resetAt - 7 * day);
    expect(timeline.ticks[7]).toMatchObject({ at: resetAt, position: 100 });
    expect(quotaCycleTimeline(window, resetAt - 3 * day)?.ticks).toEqual(timeline.ticks);
  });

  it.each([[8, 0], [7, 0], [3.5, 50], [0, 100], [-1, 100]])(
    "clamps now with %s days left to %s percent elapsed", (daysLeft, position) => {
      expect(quotaCycleTimeline(window, resetAt - daysLeft * day)?.timePosition).toBe(position);
    },
  );

  it("uses the supplied duration, independently of remaining quota", () => {
    const other = { ...window, windowSeconds: 14 * 86_400, remainingPercent: 2 };
    const timeline = quotaCycleTimeline(other, resetAt - 7 * day)!;
    expect(timeline.timePosition).toBe(50);
    expect(timeline.ticks[0]!.at).toBe(resetAt - 14 * day);
    expect(timeline.ticks).toHaveLength(8);
  });

  it("labels a month/year crossing and preserves exact endpoint dates", () => {
    const reset = new Date(2027, 0, 4, 10).getTime();
    const ticks = quotaCycleTimeline({ ...window, resetAt: reset }, reset - day)!.ticks;
    expect(ticks.map(tick => new Date(tick.at).getDate())).toEqual([28, 29, 30, 31, 1, 2, 3, 4]);
    expect(ticks[4]!.label).toBe(new Date(ticks[4]!.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(ticks[0]!.fullDate).toContain("2026");
    expect(ticks[7]!.fullDate).toContain("2027");
  });

  it.each([new Date(2026, 2, 11, 12), new Date(2026, 10, 4, 12)])(
    "keeps absolute-time positioning through DST around %s", reset => {
      const end = reset.getTime();
      const timeline = quotaCycleTimeline({ ...window, resetAt: end }, end - 3.5 * day)!;
      expect(timeline.timePosition).toBe(50);
      expect(timeline.ticks[0]!.at).toBe(end - 7 * day);
      expect(timeline.ticks[7]!.at).toBe(end);
      expect(new Set(timeline.ticks.map(tick => tick.at)).size).toBe(8);
      for (const tick of timeline.ticks) {
        expect(tick.fullDate).toBe(new Date(tick.at).toLocaleString(undefined, {
          year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
        }));
      }
    },
  );

  it.each([
    { hasKnownWindowDuration: false }, { windowSeconds: 0 }, { windowSeconds: -1 },
    { windowSeconds: NaN }, { windowSeconds: Infinity }, { windowSeconds: 1e20 },
    { resetAt: 0 }, { resetAt: -1 }, { resetAt: NaN }, { resetAt: Infinity }, { resetAt: 1e20 },
  ])("rejects unknown or invalid timing %o", invalid => {
    expect(quotaCycleTimeline({ ...window, ...invalid }, resetAt - day)).toBeNull();
  });
  it("rejects an invalid current time", () => {
    expect(quotaCycleTimeline(window, NaN)).toBeNull();
  });
});
