import { describe, expect, it } from "vitest";
import { quotaCalendarDays } from "./quota-calendar";

describe("quota reset calendar", () => {
  it("shows seven civil dates starting today and the actual reported reset", () => {
    const reset = new Date(2026, 9, 17, 23).getTime();
    const days = quotaCalendarDays(reset, new Date(2026, 9, 12, 18).getTime());
    expect(days.map(day => day.day)).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(days.filter(day => day.today).map(day => day.day)).toEqual([12]);
    expect(days.filter(day => day.reset).map(day => day.day)).toEqual([17]);
    expect(days.filter(day => day.weekend).map(day => day.day)).toEqual([17, 18]);
  });
  it("crosses month/year boundaries without assuming future resets", () => {
    const days = quotaCalendarDays(new Date(2027, 0, 1, 1).getTime(), new Date(2026, 11, 31).getTime());
    expect(days.map(day => day.day)).toEqual([31, 1, 2, 3, 4, 5, 6]);
    expect(new Set(days.map(day => day.key)).size).toBe(7);
    expect(days.filter(day => day.reset)).toHaveLength(1);
  });
  it("keeps a full civil week across daylight-saving boundaries", () => {
    const days = quotaCalendarDays(new Date(2026, 2, 8, 23).getTime(), new Date(2026, 2, 8, 1).getTime());
    expect(days.map(day => day.day)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(days[0]).toMatchObject({ today: true, reset: true });
  });
  it("does not manufacture dates for missing or invalid timestamps", () => {
    for (const reset of [0, -1, NaN, Infinity, 1e20]) expect(quotaCalendarDays(reset, Date.now())).toEqual([]);
  });
  it("includes Sunday today when the reset is in the next Monday-first week", () => {
    const days = quotaCalendarDays(new Date(2026, 9, 10, 1, 57).getTime(), new Date(2026, 9, 4, 21).getTime());
    expect(days.map(day => day.day)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(days[0]).toMatchObject({ today: true, reset: false });
    expect(days[6]).toMatchObject({ today: false, reset: true });
  });
  it("adds a distant reported reset without manufacturing intervening dates", () => {
    const days = quotaCalendarDays(new Date(2026, 10, 17).getTime(), new Date(2026, 9, 12).getTime());
    expect(days.filter(day => day.today)).toHaveLength(1);
    expect(days).toHaveLength(8);
    expect(days.slice(0, 7).map(day => day.day)).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(days[7]).toMatchObject({ key: "2026-11-17", reset: true });
  });
  it("includes the eighth-day reset in the same bounded range", () => {
    const days = quotaCalendarDays(new Date(2026, 9, 12, 10, 23).getTime(), new Date(2026, 9, 5).getTime());
    expect(days.map(day => day.day)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(days[0]?.today).toBe(true);
    expect(days[7]?.reset).toBe(true);
  });
  it("includes a passed reset once without predicting its successor", () => {
    const days = quotaCalendarDays(new Date(2026, 9, 4, 10).getTime(), new Date(2026, 9, 5).getTime());
    expect(days.map(day => day.day)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(days.filter(day => day.reset)).toHaveLength(1);
    expect(days[0]).toMatchObject({ today: false, reset: true });
    expect(days[1]?.today).toBe(true);
  });
  it("adds a reset outside the week across a year boundary", () => {
    const days = quotaCalendarDays(new Date(2027, 0, 5).getTime(), new Date(2026, 11, 29).getTime());
    expect(days.map(day => day.day)).toEqual([29, 30, 31, 1, 2, 3, 4, 5]);
    expect(new Set(days.map(day => day.key)).size).toBe(8);
    expect(days[7]).toMatchObject({ key: "2027-1-5", reset: true });
  });
  it("advances the range after local midnight", () => {
    const reset = new Date(2026, 9, 10).getTime();
    expect(quotaCalendarDays(reset, new Date(2026, 9, 4, 23, 59).getTime())[0]?.day).toBe(4);
    expect(quotaCalendarDays(reset, new Date(2026, 9, 5).getTime())[0]?.day).toBe(5);
  });
  it("rejects invalid current timestamps", () => {
    expect(quotaCalendarDays(Date.now(), NaN)).toEqual([]);
  });
});
