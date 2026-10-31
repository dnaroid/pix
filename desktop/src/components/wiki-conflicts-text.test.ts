import { describe, expect, it } from "vitest";
import { wikiColumnVerdict, wikiConflictsText, wikiVerdictLabel } from "./wiki-conflicts-text";

const cite = (path: string, quote: string) => ({ path, quote, startLine: 1, endLine: 1 });

describe("wikiColumnVerdict", () => {
  it("maps the displayed columns to canonical side verdicts in either order", () => {
    // Canonical order sorts by path: a.md is side-a even when it is the right column.
    const swapped = { draft: cite("wiki/z.md", "z"), existing: cite("wiki/a.md", "a"), internal: false };
    expect(wikiColumnVerdict(swapped, 0)).toBe("side-b");
    expect(wikiColumnVerdict(swapped, 1)).toBe("side-a");
    const text = wikiConflictsText("ru");
    expect(wikiVerdictLabel(text, swapped, wikiColumnVerdict(swapped, 0))).toBe("Права: z.md");
    expect(wikiVerdictLabel(text, swapped, wikiColumnVerdict(swapped, 1))).toBe("Права: a.md");

    const straight = { draft: cite("wiki/a.md", "a"), existing: cite("wiki/z.md", "z") };
    expect(wikiColumnVerdict(straight, 0)).toBe("side-a");
    expect(wikiColumnVerdict(straight, 1)).toBe("side-b");
  });

  it("keeps distinct verdicts for an internal finding with identical sides", () => {
    const same = cite("wiki/a.md", "x");
    const finding = { draft: same, existing: { ...same, startLine: 9, endLine: 9 } };
    expect(new Set([wikiColumnVerdict(finding, 0), wikiColumnVerdict(finding, 1)]).size).toBe(2);
  });
});
