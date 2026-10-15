import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import UsageLimitBars from "./UsageLimitBars.svelte";

const now = new Date(2026, 9, 12, 18).getTime();
const hourly = { remainingPercent: 62, resetAt: now + 2 * 3_600_000, windowSeconds: 18_000, hasKnownWindowDuration: true };
const weekly = { remainingPercent: 32, resetAt: now + 2 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true };

describe("UsageLimitBars", () => {
  it("uses the same fill color for hourly and weekly tracks while retaining their countdowns", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "H", label: "H", window: hourly }, { key: "W", label: "W", window: weekly }], now },
    });
    expect(body).toContain('aria-label="Account usage limits"');
    expect(body).toContain("Hourly");
    expect(body).toContain("Weekly");
    expect(body).toContain("62%");
    expect(body).toContain("32%");
    expect(body).toContain("width: 62%");
    expect(body.match(/class="absolute inset-y-0 right-0 bg-foreground"/g)).toHaveLength(2);
    expect(body).toContain("32%");
    expect(body).not.toContain("bg-muted-foreground");
    expect(body).toContain("bg-foreground");
    expect(body).toContain("remaining</span>");
    expect(body).toContain("Resets in 2h0m");
    expect(body.match(/data-quota-calendar/g)).toHaveLength(1);
    expect(body.match(/data-weekly-remaining-fill/g)).toHaveLength(1);
    expect(body.match(/data-weekly-day-divider/g)).toHaveLength(7);
    expect(body).not.toContain("Resets in 2d0h");
    expect(body).not.toContain("Cached");
  });

  it("shows the same unified scale with weekly-only snapshots", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "W", label: "W", window: weekly }], now } });
    expect(body).toContain("Weekly");
    expect(body).toContain("32%");
    expect(body).toContain("data-quota-cycle-dates");
    expect(body).not.toContain("Hourly");
    expect(body).not.toContain("Resets in");
  });

  it("renders nothing without quota windows", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [], now } });
    expect(body).not.toContain("data-usage-limit-bars");
  });

  it("divides a five-hour window into hour-wide segments", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "H", label: "H", window: hourly }], now } });
    expect(body).not.toContain("data-day-sector");
    expect(body).not.toContain("data-weekly-now-marker");
    expect(body).toContain("width: 62%");
    expect(body).toContain("data-hourly-dividers");
    expect(body).toContain("background-size: 20% 100%");
  });

  it.each([0, -3600, 3600, Number.NaN, Number.POSITIVE_INFINITY])("omits hourly dividers for an unsplittable duration (%s)", (windowSeconds) => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "H", label: "H", window: { ...hourly, windowSeconds } }], now } });
    expect(body).not.toContain("data-hourly-dividers");
    expect(body).toContain("data-hourly-remaining-fill");
  });

  it("does not invent hour segments for an unknown duration", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "H", label: "H", window: { ...hourly, hasKnownWindowDuration: false } }], now } });
    expect(body).not.toContain("data-hourly-dividers");
  });

  it("sizes hour segments from the full window including a partial final hour", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "H", label: "H", window: { ...hourly, windowSeconds: 9000 } }], now } });
    expect(body).toContain("background-size: 40% 100%");
  });

  it("marks stale snapshots as cached", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "W", label: "W", window: weekly }], now, stale: true } });
    expect(body).toContain("Cached");
  });

  it("explains an exhausted passed hourly window without claiming replenishment", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "H", label: "H", window: { ...hourly, remainingPercent: 0, resetAt: now } }], now } });
    expect(body).toContain("width: 0%");
    expect(body).toContain("Reset time reached · Awaiting quota refresh");
    expect(body).not.toContain("Resets in");
  });

  it("retains the cumulative daily-budget warning in the weekly header", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [{ key: "W", label: "W", window: { ...weekly, remainingPercent: 5, resetAt: now + 6 * 86_400_000 } }], now } });
    expect(body).toContain("Cumulative daily quota budget exceeded");
    expect(body).not.toContain("Resets in");
  });
});
