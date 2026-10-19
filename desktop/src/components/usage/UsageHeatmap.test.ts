import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import UsageHeatmap from "./UsageHeatmap.svelte";
import { calendarHeatmap, currentWeekWindow, periodWindow, type UsageCalendar } from "../../lib/usage-stats";

const NOW = new Date(2026, 9, 17, 15).getTime();

function rectangles(calendar: UsageCalendar): string[] {
  const { body } = render(UsageHeatmap, { props: {
    calendar, metric: "tokens", onSelectDay: () => {},
  } });
  return body.match(/<rect\b[^>]*>/gu) ?? [];
}

describe("UsageHeatmap week boundaries", () => {
  it.each([0, 1, 6])("keeps seven cells per week for locale week start %i", (weekStart) => {
    for (const period of ["7d", "30d", "90d", "all"] as const) {
      const window = period === "7d" ? currentWeekWindow(NOW, weekStart) : periodWindow(period, NOW, null);
      const calendar = calendarHeatmap([{
        startMs: NOW, width: "hour", provider: "anthropic", model: "opus", values: { totalTokens: 10 },
      }], "tokens", window, NOW, weekStart);
      const cells = rectangles(calendar);
      expect(cells).toHaveLength(calendar.weeks.length * 7);
      const padding = cells.filter((cell) => cell.includes('fill="none"'));
      expect(padding).toHaveLength(calendar.weeks.flat().filter((day) => day?.outside).length);
      for (const cell of padding) {
        expect(cell).toContain('aria-hidden="true"');
        expect(cell).not.toMatch(/\b(?:role|tabindex|aria-label|aria-pressed)=/u);
      }
      expect(cells.filter((cell) => cell.includes('role="button"'))).toHaveLength(1);
      expect(calendar.total).toBe(10);
    }
  });

  it("draws empty squares for missing boundary dates instead of cutting off columns", () => {
    const cells = rectangles({
      weekStart: 1, max: 10, total: 10,
      weeks: [
        [null, null, { key: "2026-10-14", value: 10 }, { key: "2026-10-15", value: 0 },
          { key: "2026-10-16", value: 0 }, { key: "2026-10-17", value: 0 }, null],
      ],
    });
    expect(cells).toHaveLength(7);
    for (const index of [0, 1, 6]) {
      expect(cells[index]).toContain('fill="none"');
      expect(cells[index]).toContain(`y="${12 + index * 16 + 0.5}"`);
    }
  });

  it("colors context days without making them selectable or including them in the summary", () => {
    const calendar = calendarHeatmap([
      { startMs: new Date(2026, 9, 10, 9).getTime(), width: "hour", provider: "anthropic", model: "opus", values: { totalTokens: 30 } },
      { startMs: NOW, width: "hour", provider: "anthropic", model: "opus", values: { totalTokens: 10 } },
    ], "tokens", periodWindow("7d", NOW, null), NOW, 1);
    const cells = rectangles(calendar);
    expect(cells[5]).toContain('fill="var(--tool-info)"');
    expect(cells[5]).toContain('fill-opacity="1"');
    expect(cells[5]).not.toMatch(/\b(?:role|tabindex|aria-pressed)=/u);
    const { body } = render(UsageHeatmap, { props: { calendar, metric: "tokens" } });
    expect(body).toContain("1 of 7 days active, 10 tok total.");
  });
});
