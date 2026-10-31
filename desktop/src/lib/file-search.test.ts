import { describe, expect, it } from "vitest";
import { findSpanIndex, findTextMatches, lineIndexAt } from "./file-search";

describe("findTextMatches", () => {
  it("finds literal ASCII-case-insensitive matches with stable text offsets", () => {
    expect(findTextMatches("Needle\nneedle NEEDLE", "needle")).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 13 },
      { start: 14, end: 20 },
    ]);
  });

  it("returns non-overlapping matches and respects its bound", () => {
    expect(findTextMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findTextMatches("x x x", "x", 2)).toHaveLength(2);
  });

  it("does not search an empty query", () => {
    expect(findTextMatches("text", "   ")).toEqual([]);
  });

  it("keeps meaningful leading and trailing spaces literal", () => {
    expect(findTextMatches("a x b x ", " x ")).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 8 },
    ]);
  });

  it("does not reuse a folded haystack across different texts", () => {
    expect(findTextMatches("ABC abc", "abc")).toHaveLength(2);
    expect(findTextMatches("xyz ABC", "abc")).toEqual([{ start: 4, end: 7 }]);
    expect(findTextMatches("ÄBC", "äbc")).toEqual([]); // ASCII-only folding stays offset-stable
  });
});

describe("findSpanIndex", () => {
  const spans = [{ start: 0, end: 5 }, { start: 5, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 12 }];
  it("locates match starts and ends across contiguous spans, skipping empty spans", () => {
    expect(findSpanIndex(spans, 0, "start")).toBe(0);
    expect(findSpanIndex(spans, 5, "start")).toBe(2);
    expect(findSpanIndex(spans, 5, "end")).toBe(0);
    expect(findSpanIndex(spans, 9, "end")).toBe(2);
    expect(findSpanIndex(spans, 11, "start")).toBe(3);
    expect(findSpanIndex(spans, 12, "start")).toBe(-1);
    expect(findSpanIndex(spans, 0, "end")).toBe(-1);
    expect(findSpanIndex([], 0, "start")).toBe(-1);
  });
  it("agrees with a linear scan", () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ start: index * 3, end: index * 3 + (index % 4 === 0 ? 0 : 3) }))
      .map((span, index, all) => ({ start: span.start, end: index + 1 < all.length ? all[index + 1]!.start : span.end }));
    for (let offset = 0; offset <= 150; offset++) {
      expect(findSpanIndex(many, offset, "start")).toBe(many.findIndex((span) => offset >= span.start && offset < span.end));
      expect(findSpanIndex(many, offset, "end")).toBe(many.findIndex((span) => offset > span.start && offset <= span.end));
    }
  });
});

describe("lineIndexAt", () => {
  it("counts newlines before an offset", () => {
    expect(lineIndexAt("a\nb\nc", 0)).toBe(0);
    expect(lineIndexAt("a\nb\nc", 2)).toBe(1);
    expect(lineIndexAt("a\nb\nc", 1)).toBe(0);
    expect(lineIndexAt("a\nb\nc", 4)).toBe(2);
  });
});
