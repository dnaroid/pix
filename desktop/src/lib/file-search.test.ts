import { describe, expect, it } from "vitest";
import { findTextMatches } from "./file-search";

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
});
