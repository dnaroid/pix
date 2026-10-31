import { describe, expect, it } from "vitest";
import { formatWikiDate, newerWikiSide, wikiQuoteTime, type WikiFileDates } from "./wiki-file-dates";

const dates = (extra: Partial<WikiFileDates> = {}): WikiFileDates => ({
  createdAt: 1_000, committedAt: 5_000, modifiedAt: 9_000, uncommitted: false,
  linesCommittedAt: 3_000, linesUncommitted: false, tracked: true, ...extra,
});

describe("Wiki file dates", () => {
  it("dates the quoted text by its lines, then the file commit, then the file time", () => {
    expect(wikiQuoteTime(dates())).toBe(3_000);
    expect(wikiQuoteTime(dates({ linesCommittedAt: null }))).toBe(5_000);
    expect(wikiQuoteTime(dates({ linesUncommitted: true }))).toBe(9_000);
    expect(wikiQuoteTime(dates({ tracked: false, uncommitted: true, committedAt: null, linesCommittedAt: null }))).toBe(9_000);
    expect(wikiQuoteTime(dates({ tracked: false, committedAt: null, linesCommittedAt: null, modifiedAt: null }))).toBeNull();
  });

  it("marks the newer side only when both times are known and differ", () => {
    expect(newerWikiSide([dates(), dates({ linesCommittedAt: 4_000 })])).toBe(1);
    expect(newerWikiSide([dates({ linesUncommitted: true }), dates()])).toBe(0);
    expect(newerWikiSide([dates(), dates()])).toBeNull();
    expect(newerWikiSide([dates(), null])).toBeNull();
  });

  it("formats in the report language", () => {
    const time = Date.UTC(2026, 9, 30, 12, 0);
    expect(formatWikiDate(time, "ru")).toMatch(/2026/u);
    expect(formatWikiDate(time, "en")).toMatch(/2026/u);
  });
});
