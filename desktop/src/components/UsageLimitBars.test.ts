import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import UsageLimitBars from "./UsageLimitBars.svelte";

const now = new Date(2026, 9, 12, 18).getTime();
const hourly = { remainingPercent: 62, resetAt: now + 2 * 3_600_000, windowSeconds: 18_000, hasKnownWindowDuration: true };
const weekly = { remainingPercent: 32, resetAt: now + 2 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true };

describe("UsageLimitBars", () => {
  it("renders one neutral-track row per account quota window with tone-colored percent and countdown", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "H", label: "H" as const, window: hourly }, { key: "W", label: "W" as const, window: weekly }], now },
    });
    expect(body).toContain('aria-label="Account usage limits"');
    expect(body).toContain("Hourly");
    expect(body).toContain("Weekly");
    expect(body).toContain("62%");
    expect(body).toContain("32%");
    expect(body).toContain("bg-muted-foreground");
    expect(body).not.toContain("bg-muted-foreground/50");
    expect(body).toContain("remaining</span>");
    expect(body).toContain("Resets in 2h0m");
    expect(body).toContain("h-2 w-full");
    expect(body).not.toContain("Rate");
    expect(body).not.toContain("Cached");
  });

  it("shows a weekly balance and countdown even without an hourly window", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: weekly }], now },
    });
    expect(body).toContain("Weekly");
    expect(body).toContain("32%");
    expect(body).toContain("width: 32%");
    expect(body).toContain("Resets in 2d0h");
    expect(body).not.toContain("Hourly");
  });

  it("renders nothing when there are no account quota windows", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [], now } });
    expect(body).not.toContain("data-usage-limit-bars");
    expect(body).not.toContain("Limits");
  });

  it("divides the weekly track into seven day sectors without splitting the aggregate balance", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: weekly }], now },
    });
    expect(body).toContain("data-weekly-day-sectors");
    expect(body.match(/data-day-sector/g)).toHaveLength(7);
    expect(body.match(/border-l border-background\/80/g)).toHaveLength(6);
    expect(body).toContain("width: 32%");
  });

  it("keeps short-window tracks continuous", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "H", label: "H" as const, window: hourly }], now },
    });
    expect(body).not.toContain("data-day-sector");
    expect(body).not.toContain("data-weekly-now-marker");
    expect(body).toContain("width: 62%");
  });

  it.each([
    ["before start", 8, 100],
    ["start", 7, 100],
    ["midpoint", 3.5, 50],
    ["reset", 0, 0],
    ["after reset", -1, 0],
  ])("positions now at %s independently of quota remaining", (_label, daysRemaining, position) => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: { ...weekly, resetAt: now + Number(daysRemaining) * 86_400_000 } }], now },
    });
    expect(body).toContain("data-weekly-now-marker");
    expect(body).toContain(`left: clamp(1px, ${position}%, calc(100% - 1px))`);
    expect(body).toContain(`Now: ${position}% of window time remaining (start right, reset left)`);
    expect(body).toContain("width: 32%");
  });

  it("moves the marker with now without changing the quota fill", () => {
    const windows = [{ key: "W", label: "W" as const, window: { ...weekly, resetAt: now + 7 * 86_400_000 } }];
    const start = render(UsageLimitBars, { props: { windows, now } }).body;
    const later = render(UsageLimitBars, { props: { windows, now: now + 3.5 * 86_400_000 } }).body;
    expect(start).toContain("left: clamp(1px, 100%, calc(100% - 1px))");
    expect(later).toContain("left: clamp(1px, 50%, calc(100% - 1px))");
    expect(later).toContain("width: 32%");
  });

  it.each([
    { hasKnownWindowDuration: false },
    { windowSeconds: 0 },
    { windowSeconds: -1 },
    { windowSeconds: Number.NaN },
    { windowSeconds: Number.POSITIVE_INFINITY },
    { resetAt: Number.NaN },
    { resetAt: 0 },
    { resetAt: Number.POSITIVE_INFINITY },
  ])("omits the time marker for unknown or invalid timing %o", (invalid) => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: { ...weekly, ...invalid } }], now },
    });
    expect(body).not.toContain("data-weekly-now-marker");
    expect(body).toContain("width: 32%");
  });

  it("marks stale snapshots as cached", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "H", label: "H" as const, window: hourly }], now, stale: true },
    });
    expect(body).toContain("Cached");
  });

  it("explains an exhausted, passed window without claiming replenishment", () => {
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "H", label: "H" as const, window: { ...hourly, remainingPercent: 0, resetAt: now } }], now },
    });
    expect(body).toContain("0%");
    expect(body).toContain("remaining</span>");
    expect(body).toContain("width: 0%");
    expect(body).toContain("Reset time reached · Awaiting quota refresh");
    expect(body).not.toContain("Resets in");
  });

  it("flags a window exceeding its cumulative daily budget", () => {
    const longWeekly = { remainingPercent: 5, resetAt: now + 6 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true };
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: longWeekly }], now },
    });
    expect(body).toContain("Cumulative daily quota budget exceeded");
  });
});
