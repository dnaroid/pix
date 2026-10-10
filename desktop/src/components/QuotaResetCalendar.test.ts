import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import QuotaResetCalendar from "./QuotaResetCalendar.svelte";

const now = new Date(2026, 9, 10, 3, 12).getTime();
const window = { remainingPercent: 57, resetAt: new Date(2026, 9, 14, 10, 12).getTime(), windowSeconds: 604_800, hasKnownWindowDuration: true };

function renderCalendar(overrides = {}) {
  return render(QuotaResetCalendar, { props: { window: { ...window, ...overrides }, now } }).body;
}

describe("QuotaResetCalendar unified track", () => {
  it("renders one right-anchored remaining-quota track, seven sectors and eight date ticks", () => {
    const body = renderCalendar();
    expect(body.match(/data-weekly-remaining-fill/g)).toHaveLength(1);
    expect(body).toContain("width: 57%");
    expect(body).toContain("absolute inset-y-0 right-0 bg-foreground");
    expect(body.match(/data-day-sector/g)).toHaveLength(7);
    expect(body.match(/border-l border-background\/40/g)).toHaveLength(6);
    expect(body).toContain("data-quota-cycle-dates");
    expect(body.match(/quota reset/g)).toHaveLength(1);
    expect(body).toContain("Weekly account quota: 43% used, 57% remaining");
    expect(body).not.toContain("bg-primary font-semibold");
  });

  it("keeps timing details accessible without extra visible labels or footer", () => {
    const body = renderCalendar();
    expect(body).toContain("of window time elapsed (start left, reset right)");
    expect(body).toContain(new Date(window.resetAt).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }));
    const visible = body.replace(/<[^>]*>/g, "");
    expect(visible).not.toMatch(/Now|used|Resets in|Weekly reset|2026|10:12|Local time/);
    expect(body).not.toContain("data-quota-reset-detail");
    expect(body).not.toContain("title=");
  });

  it.each([[8, 0], [7, 0], [3.5, 50], [0, 100], [-1, 100]])(
    "positions the pin at %s days left independently of quota", (daysLeft, position) => {
      const body = renderCalendar({ resetAt: now + daysLeft * 86_400_000 });
      expect(body).toContain(`left: clamp(3px, ${position}%, calc(100% - 3px))`);
      expect(body).toContain("width: 57%");
      expect(body).toContain(`Now: ${position}% of window time elapsed`);
    },
  );

  it("moves only the pin as the existing minute tick advances", () => {
    const start = window.resetAt - window.windowSeconds * 1000;
    const first = render(QuotaResetCalendar, { props: { window, now: start } }).body;
    const later = render(QuotaResetCalendar, { props: { window, now: start + 3.5 * 86_400_000 } }).body;
    expect(first).toContain("left: clamp(3px, 0%, calc(100% - 3px))");
    expect(later).toContain("left: clamp(3px, 50%, calc(100% - 3px))");
    expect(later).toContain("width: 57%");
  });

  it.each([[100, 100], [0, 0], [-10, 0], [110, 100], [78, 78]])("clamps %s remaining to %s filled", (remainingPercent, filled) => {
    expect(renderCalendar({ remainingPercent })).toContain(`width: ${filled}%`);
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
      expect(body).toContain("width: 57%");
      expect(body).toContain("unavailable");
    },
  );

  it("preserves a passed reset warning without claiming replenishment", () => {
    const body = renderCalendar({ resetAt: now, remainingPercent: 0 });
    expect(body).toContain("Reset time reached · Awaiting quota refresh");
    expect(body).toContain("width: 0%");
    expect(body).not.toContain("Resets in");
  });
});
