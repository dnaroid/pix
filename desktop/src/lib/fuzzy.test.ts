import { describe, expect, it } from "vitest";

import { fuzzySearch } from "./fuzzy";

describe("fuzzySearch", () => {
  const items = [
    { value: "open", label: "Open File", aliases: ["find"], keywords: ["file picker"] },
    { value: "status", label: "Git Status" },
    { value: "switch", label: "Switch Session" },
  ] as const;

  it("returns ranked matches with matched ranges", () => {
    const matches = fuzzySearch(items, "gs");
    expect(matches[0]?.value).toBe("status");
    expect(matches[0]?.matchedText).toBe("Git Status");
    expect(matches[0]?.matchedRanges).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  it("searches aliases and keywords, trims query casing, and respects limits", () => {
    const [match] = fuzzySearch(items, " PICK ", { limit: 1 });
    expect(match?.value).toBe("open");
    expect(match?.matchedText).toBe("file picker");
  });

  it("matches queries typed with the Russian keyboard layout selected", () => {
    const [match] = fuzzySearch(
      [
        { value: "new", label: "new" },
        { value: "resume", label: "resume" },
      ],
      "туц",
      { limit: 1 },
    );

    expect(match?.value).toBe("new");
    expect(match?.matchedRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it("can prefer keyboard-layout matches over literal fuzzy matches", () => {
    const matches = fuzzySearch(
      [
        { value: "russian", label: "важную логику покрыть" },
        { value: "sdk", label: "read sdk docs" },
      ],
      "ыВЛ",
      { preferKeyboardLayoutMatches: true },
    );

    expect(matches.map((match) => match.value)).toEqual(["sdk"]);
  });

  it("can reject weak dispersed subsequence matches", () => {
    const matches = fuzzySearch(
      [
        {
          value: "prompt",
          label: "Generate one PNG image of a single standalone transparent mobile game asset",
        },
        { value: "sdk", label: "read sdk references" },
      ],
      "sdk",
      { minScorePerCharacter: 8 },
    );

    expect(matches.map((match) => match.value)).toEqual(["sdk"]);
  });

  it("matches Russian labels from queries typed with the English keyboard layout selected", () => {
    const [match] = fuzzySearch(
      [
        { value: "new", label: "новый" },
        { value: "resume", label: "возобновить" },
      ],
      "yjd",
      { limit: 1 },
    );

    expect(match?.value).toBe("new");
    expect(match?.matchedRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it("handles empty and unmatched queries", () => {
    expect(fuzzySearch(items, "", { includeEmptyQuery: false })).toEqual([]);
    expect(fuzzySearch(items, "zzzz")).toEqual([]);
    expect(fuzzySearch(items, "")).toHaveLength(items.length);
  });

  it("keeps original rank for tied scores", () => {
    const tied = fuzzySearch(
      [
        { value: 1, label: "Alpha" },
        { value: 2, label: "Alps" },
      ],
      "",
    );
    expect(tied.map((match) => match.value)).toEqual([1, 2]);
  });
});
