import { describe, expect, it } from "vitest";

// Prevent regressions across all Desktop disclosures, not just the search dialog.
// The native <summary> marker is hidden in Pix's styling, so a bare summary
// makes the expand/collapse affordance disappear.
const components = import.meta.glob("./**/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("Desktop design contract: disclosure chevrons", () => {
  it("every native summary renders a state-rotating Lucide chevron", () => {
    let count = 0;
    for (const [filename, source] of Object.entries(components)) {
      for (const summary of source.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gu)) {
        const body = summary[1] ?? "";
        const message = `${filename}: disclosures must include a visible state-rotating ChevronRight/ChevronDown (DESIGN.md §12.3)`;
        expect(body, message).toMatch(/<Chevron(?:Right|Down|Left|Up)\b/u);
        expect(body, message).toMatch(/rotate-(?:0|90|180|270)/u);
        count++;
      }
    }
    expect(count).toBeGreaterThan(15);
  });
});
