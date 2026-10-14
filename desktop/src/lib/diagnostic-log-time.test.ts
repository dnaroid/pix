import { describe, expect, it } from "vitest";
import { formatDiagnosticLogTime } from "./diagnostic-log-time";

describe("diagnostic log local time", () => {
  it("uses the host's local calendar and clock, preserving milliseconds", () => {
    const timestamp = "2026-01-01T01:04:05.067Z";
    const date = new Date(timestamp);
    const result = formatDiagnosticLogTime(timestamp);
    const parts = result.match(/^(\d+)-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    expect(parts?.slice(1).map(Number)).toEqual([
      date.getFullYear(), date.getMonth() + 1, date.getDate(),
      date.getHours(), date.getMinutes(), date.getSeconds(), 67,
    ]);
    expect(result).not.toContain("Z");
  });

  it("uses the local offset applicable at the record's date, including DST", () => {
    for (const timestamp of ["2026-01-14T12:00:00.000Z", "2026-07-14T12:00:00.000Z"]) {
      const date = new Date(timestamp);
      expect(formatDiagnosticLogTime(timestamp).slice(11, 13)).toBe(String(date.getHours()).padStart(2, "0"));
    }
  });

  it("preserves invalid timestamps instead of throwing", () => {
    expect(formatDiagnosticLogTime("invalid")).toBe("invalid");
  });
});
