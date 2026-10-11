import { describe, expect, it } from "vitest";
import { normalizeSearchConcepts } from "./search-query";

describe("technical search query normalization", () => {
  it("finds English autocomplete identifiers from Russian feature names without matching generic Auto", () => {
    for (const term of ["авто-пополнение", "авто пополнение", "автодополнение", "автозавершение"]) {
      expect(normalizeSearchConcepts(term)).toBe("autocomplete");
    }
    expect(normalizeSearchConcepts("Auto by default")).toBe("Auto by default");
    expect(normalizeSearchConcepts("auto completion" )).toBe("autocomplete");
    expect(normalizeSearchConcepts("SearchAutocompleteModel")).toBe("SearchAutocompleteModel");
  });
});
