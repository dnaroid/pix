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

  it("renders nothing when there are no account quota windows", () => {
    const { body } = render(UsageLimitBars, { props: { windows: [], now } });
    expect(body).not.toContain("data-usage-limit-bars");
    expect(body).not.toContain("Limits");
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

  it("flags a window projected to exhaust before its reset", () => {
    const longWeekly = { remainingPercent: 5, resetAt: now + 6 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true };
    const { body } = render(UsageLimitBars, {
      props: { windows: [{ key: "W", label: "W" as const, window: longWeekly }], now },
    });
    expect(body).toContain("Projected to exhaust before reset");
  });
});
