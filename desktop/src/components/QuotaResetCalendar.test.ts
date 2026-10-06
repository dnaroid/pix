import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import QuotaResetCalendar from "./QuotaResetCalendar.svelte";

const now = new Date(2026, 9, 12, 18).getTime();
const window = { remainingPercent: 35, resetAt: new Date(2026, 9, 17, 23).getTime(), windowSeconds: 604800 };

describe("QuotaResetCalendar", () => {
  it("colors weekend labels and dates while preserving today and reset markers, without a legend", () => {
    const { body } = render(QuotaResetCalendar, { props: { window, now: new Date(2026, 9, 18, 12).getTime() } });
    expect(body.match(/truncate text-xs text-tool-error/g)).toHaveLength(3);
    expect(body).toMatch(/border-muted-foreground\/40 bg-muted\/40 text-tool-error[^>]*aria-label="[^"]*, today"/);
    expect(body).not.toContain("Outlined date:");
    expect(body).not.toContain("Highlighted date:");
    const resetBody = render(QuotaResetCalendar, { props: { window, now } }).body;
    expect(resetBody).toMatch(/border-primary\/40 bg-primary\/10 text-tool-error[^>]*aria-label="[^"]*, quota reset"/);
  });
  it("shows the reset calendar without duplicate percentage, track or countdown", () => {
    const { body } = render(QuotaResetCalendar, { props: { window, now } });
    expect(body).toContain('aria-label="Weekly account quota"');
    expect(body).not.toContain("35%");
    expect(body).not.toContain("Account quota · Weekly");
    expect(body).not.toContain('style="width:');
    expect(body).not.toContain("Resets in");
    expect(body).not.toContain("Local time");
    expect(body.match(/quota reset/g)).toHaveLength(1);
    expect(body).toContain('aria-current="date"');
    expect(body).not.toContain("Cached");
    expect(body).toContain("flex h-6 items-center");
    expect(body).toContain("data-quota-reset-detail");
    expect(body).not.toContain("rounded-md bg-muted px-2.5 py-2");
  });
  it("marks cached data and never claims a passed reset has refreshed the quota", () => {
    const { body } = render(QuotaResetCalendar, { props: { window, now: window.resetAt + 1, stale: true } });
    expect(body).toContain("Cached");
    expect(body).toContain("Awaiting quota refresh");
    expect(body).not.toContain("Resets in");
  });
  it("shows today across the week boundary and formats reset time without a timezone", () => {
    const resetAt = new Date(2026, 9, 10, 1, 57).getTime();
    const { body } = render(QuotaResetCalendar, { props: { window: { ...window, resetAt }, now: new Date(2026, 9, 4, 21).getTime() } });
    expect(body).toContain('aria-label="Today’s week and reset date"');
    expect(body).toContain('aria-current="date"');
    expect(body.match(/quota reset/g)).toHaveLength(1);
    expect(body).toContain(new Date(resetAt).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    }));
    expect(body).not.toMatch(/GMT|UTC/);
  });
  it("shows an honest unavailable state without calendar dates", () => {
    const { body } = render(QuotaResetCalendar, { props: { window: { ...window, resetAt: 0 }, now } });
    expect(body).toContain("Reset time unavailable");
    expect(body).not.toContain("quota reset");
    expect(body).not.toContain("Resets in");
  });
  it("keeps the eighth-day reset and today in one eight-column row", () => {
    const resetAt = new Date(2026, 9, 12, 10, 23).getTime();
    const { body } = render(QuotaResetCalendar, { props: { window: { ...window, resetAt }, now: new Date(2026, 9, 5).getTime() } });
    expect(body).toContain("grid-template-columns: repeat(8, minmax(0, 1fr))");
    expect(body.match(/quota reset/g)).toHaveLength(1);
    expect(body.match(/aria-current="date"/g)).toHaveLength(1);
    expect(body).toContain("border-primary/40 bg-primary/10");
    expect(body).not.toContain("grid-cols-7");
  });
});
