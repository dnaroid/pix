import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import QuotaResetCalendar from "./QuotaResetCalendar.svelte";

const now = new Date(2026, 9, 10, 3, 12).getTime();
const window = { remainingPercent: 57, resetAt: new Date(2026, 9, 14, 10, 12).getTime(), windowSeconds: 604_800, hasKnownWindowDuration: true };

function renderCalendar(overrides = {}) {
  return render(QuotaResetCalendar, { props: { window: { ...window, ...overrides }, now } }).body;
}

function fills(body: string): number[] {
  return [...body.matchAll(/style="width: ([\d.]+)%" data-weekly-remaining-fill/g)].map(m => Number(m[1]));
}

describe("QuotaResetCalendar calendar-day segments", () => {
  it("renders one gapped right-anchored segment per calendar day with weekday and date labels", () => {
    const body = renderCalendar();
    // Oct 7 03:12 .. Oct 14 10:12 touches 8 calendar days (first and last partial).
    expect(body.match(/data-day-sector/g)).toHaveLength(8);
    expect(body.match(/data-weekly-remaining-fill/g)).toHaveLength(8);
    expect(body).toContain("absolute inset-y-0 right-0 bg-foreground");
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
  });

  it.each([100, 57, 0])("covers %s%% of the time axis, right-anchored", remainingPercent => {
    const values = fills(renderCalendar({ remainingPercent }));
    expect(values).toHaveLength(8);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    if (remainingPercent === 100) expect(values.every(v => v === 100)).toBe(true);
    if (remainingPercent === 0) expect(values.every(v => v === 0)).toBe(true);
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
    expect(body).toContain("data-quota-reset-time");
    expect(visible).toContain("Reset ");
    expect(body).not.toContain("title=");
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
    expect(first).toContain("calc(0px + 0 *");
    expect(later).not.toContain("calc(0px + 0 *");
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
      expect(body).toContain("unavailable");
    },
  );

  it("preserves a passed reset warning without claiming replenishment", () => {
    const body = renderCalendar({ resetAt: now, remainingPercent: 0 });
    expect(body).toContain("Reset time reached · Awaiting quota refresh");
    expect(body).not.toContain("Resets in");
  });

  it("marks reset-credit deadlines that fall inside the window in red", () => {
    const inside = now + 2 * 86_400_000;
    const body = render(QuotaResetCalendar, { props: { window, now, deadlines: [inside, inside, window.resetAt + 86_400_000, now - 30 * 86_400_000] } }).body;
    expect(body.match(/data-reset-credit-deadline/g)).toHaveLength(1);
    expect(body).toContain("bg-tool-error");
    expect(body).toContain("Reset credits expire:");
    expect(renderCalendar()).not.toContain("data-reset-credit-deadline");
  });
});
