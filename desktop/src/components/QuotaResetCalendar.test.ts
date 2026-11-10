import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import { quotaCycleTimeline } from "../lib/quota-calendar";
import QuotaResetCalendar from "./QuotaResetCalendar.svelte";

const now = new Date(2026, 9, 10, 3, 12).getTime();
const window = { remainingPercent: 57, resetAt: new Date(2026, 9, 14, 10, 12).getTime(), windowSeconds: 604_800, hasKnownWindowDuration: true };

function renderCalendar(overrides = {}) {
  return render(QuotaResetCalendar, { props: { window: { ...window, ...overrides }, now } }).body;
}

function fills(body: string): number[] {
  return [...body.matchAll(/style="width: ([\d.]+)%" data-weekly-remaining-fill/g)].map(m => Number(m[1]));
}

function dividers(body: string): number[] {
  return [...body.matchAll(/style="left: ([\d.]+)%" data-weekly-day-divider/g)].map(m => Number(m[1]));
}

describe("QuotaResetCalendar continuous weekly timeline", () => {
  it("renders one continuous right-anchored fill with thin calendar-day dividers and date labels", () => {
    const body = renderCalendar();
    // Oct 7 03:12 .. Oct 14 10:12 touches 8 calendar days (first and last partial).
    expect(body).toContain("data-weekly-progress-track");
    expect(body.match(/data-weekly-remaining-fill/g)).toHaveLength(1);
    expect(body.match(/data-weekly-day-divider/g)).toHaveLength(7);
    expect(body).toContain("absolute inset-y-0 w-px bg-popover/80");
    expect(body).not.toContain("data-day-sector");
    expect(body).toContain("data-quota-cycle-dates");
    expect(body.match(/data-quota-day="today"/g)).toHaveLength(1);
    expect(body.match(/uppercase tracking-wide/g)).toHaveLength(8);
    expect(body.match(/quota resets/g)).toHaveLength(1);
    expect(body).toContain("Weekly account quota: 43% used, 57% remaining");
  });

  it("widths are proportional to time so the first and last days are partial", () => {
    const body = renderCalendar();
    const cols = body.match(/grid-template-columns: ([^"]+?);/)![1]!;
    const fr = [...cols.matchAll(/minmax\(0, ([\d.]+)fr\)/g)].map(m => Number(m[1]));
    expect(fr).toHaveLength(8);
    expect(fr.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(fr[0]).toBeLessThan(fr[1]!);
    expect(fr[7]).toBeLessThan(fr[1]!);
    expect(dividers(body)).toEqual(quotaCycleTimeline(window, now)!.days.slice(0, -1).map(d => d.endFraction * 100));
  });

  it.each([100, 57, 0])("covers %s%% of the time axis, right-anchored", remainingPercent => {
    const values = fills(renderCalendar({ remainingPercent }));
    expect(values).toEqual([remainingPercent]);
  });

  it("marks the calendar date containing now as today", () => {
    const body = renderCalendar();
    const today = body.match(/data-quota-day="today"[^>]*>(?:<span[^>]*>[^<]*<\/span>\s*)<span[^>]*>(\d+)</);
    expect(today?.[1]).toBe("10");
  });

  it("keeps timing details accessible without extra visible labels", () => {
    const body = renderCalendar();
    expect(body).toContain("of window time elapsed (start left, reset right)");
    const visible = body.replace(/<[^>]*>/g, "");
    expect(visible).not.toMatch(/Now|used|Resets in|Weekly reset|2026|Local time/);
    expect(visible).not.toMatch(/sleep|After|hours/i);
    expect(visible).toContain("+6h");
    expect(body).toContain("data-quota-reset-time");
    expect(visible).toContain("Reset ");
    expect(body).not.toContain("title=");
  });

  it("adds a +6h marker six hours after now without changing quota fill", () => {
    const body = renderCalendar();
    const expected = quotaCycleTimeline(window, now + 6 * 3_600_000)!.timePosition;
    expect(body).toContain("data-weekly-sleep-marker");
    expect(body).toContain(`left: clamp(5px, ${expected}%, calc(100% - 5px))`);
    expect(body).toContain("After 6 hours of sleep:");
    expect(body).toContain("+6h</span>");
    expect(body).not.toContain("lucide-moon");
    expect(body).toContain("bg-tool-agent ring-1 ring-popover");
    expect(fills(body)).toEqual([57]);
  });

  it("uses the configured duration and the same absolute minute tick", () => {
    const sleepHours = 8.5;
    const start = window.resetAt - window.windowSeconds * 1000;
    for (const at of [now, now + 60_000]) {
      const body = render(QuotaResetCalendar, { props: { window, now: at, sleepHours } }).body;
      const expected = (at + sleepHours * 3_600_000 - start) / (window.windowSeconds * 1000) * 100;
      expect(body).toContain(`left: clamp(5px, ${expected}%, calc(100% - 5px))`);
      expect(body).toContain("After 8.5 hours of sleep:");
      expect(body).toContain("+8.5h</span>");
      expect(fills(body)).toEqual([57]);
    }
  });

  it.each([new Date(2026, 2, 8, 0, 30), new Date(2026, 10, 1, 0, 30)])(
    "positions sleep by elapsed hours across DST at %s", date => {
      const at = date.getTime();
      const reported = { ...window, resetAt: at + 3 * 86_400_000 };
      const body = render(QuotaResetCalendar, { props: { window: reported, now: at } }).body;
      const expected = quotaCycleTimeline(reported, at + 6 * 3_600_000)!.timePosition;
      expect(body).toContain(`left: clamp(5px, ${expected}%, calc(100% - 5px))`);
      expect(body).toContain(new Date(at + 6 * 3_600_000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }));
    },
  );

  it.each([0, -1, 25, NaN, Infinity])("omits a marker with invalid duration %s", sleepHours => {
    const body = render(QuotaResetCalendar, { props: { window, now, sleepHours } }).body;
    expect(body).not.toContain("data-weekly-sleep-marker");
  });

  it("allows sleep ending exactly at reset but never predicts beyond the reported window", () => {
    const at = window.resetAt - 6 * 3_600_000;
    expect(render(QuotaResetCalendar, { props: { window, now: at } }).body).toContain("left: clamp(5px, 100%, calc(100% - 5px))");
    for (const invalidNow of [at + 1, window.resetAt, window.resetAt + 1, window.resetAt - 8 * 86_400_000]) {
      expect(render(QuotaResetCalendar, { props: { window, now: invalidNow } }).body).not.toContain("data-weekly-sleep-marker");
    }
  });

  it.each([[8, 0], [7, 0], [3.5, 50], [0, 100], [-1, 100]])(
    "reports %s days left as %s%% elapsed", (daysLeft, position) => {
      const body = renderCalendar({ resetAt: now + daysLeft * 86_400_000 });
      expect(body).toContain(`Now: ${position}% of window time elapsed`);
      expect(body).toContain("data-weekly-now-marker");
    },
  );

  it("moves only the pin as the minute tick advances", () => {
    const start = window.resetAt - window.windowSeconds * 1000;
    const first = render(QuotaResetCalendar, { props: { window, now: start } }).body;
    const later = render(QuotaResetCalendar, { props: { window, now: start + 3.5 * 86_400_000 } }).body;
    expect(fills(first)).toEqual(fills(later));
    expect(dividers(first)).toEqual(dividers(later));
    expect(first).toContain("left: clamp(3px, 0%, calc(100% - 3px))");
    expect(later).toContain("left: clamp(3px, 50%, calc(100% - 3px))");
  });

  it("keeps a contrasting pin stem and a triangular head", () => {
    const body = renderCalendar();
    expect(body).toContain("w-0.5 -translate-x-1/2 bg-primary ring-1 ring-popover");
    expect(body).toContain('d="M0 0H8L4 6Z"');
  });

  it.each([{ hasKnownWindowDuration: false }, { windowSeconds: 0 }, { resetAt: NaN }, { resetAt: 0 }, { resetAt: 1e20 }])(
    "omits fabricated dates and pin for invalid timing %o", invalid => {
      const body = renderCalendar(invalid);
      expect(body).not.toContain("data-quota-cycle-dates");
      expect(body).not.toContain("data-weekly-now-marker");
      expect(body).not.toContain("data-weekly-sleep-marker");
      expect(body).toContain("unavailable");
    },
  );

  it("preserves a passed reset warning without claiming replenishment", () => {
    const body = renderCalendar({ resetAt: now, remainingPercent: 0 });
    expect(body).toContain("Reset time reached · Awaiting quota refresh");
    expect(body).not.toContain("Resets in");
  });

  it("marks reset-credit deadlines that fall inside the window in red", () => {
    const inside = window.resetAt - window.windowSeconds * 500;
    const body = render(QuotaResetCalendar, { props: { window, now, deadlines: [inside, inside, window.resetAt + 86_400_000, now - 30 * 86_400_000] } }).body;
    expect(body.match(/data-reset-credit-deadline/g)).toHaveLength(1);
    expect(body).toContain("bg-tool-error");
    expect(body).toContain("left: clamp(1px, 50%, calc(100% - 1px))");
    expect(body).toContain("Reset credits expire:");
    expect(renderCalendar()).not.toContain("data-reset-credit-deadline");
  });
});
