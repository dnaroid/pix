import { describe, expect, it } from "vitest";
import { indexSearchQuery, normalizeSearchConcepts } from "./search-query";

describe("technical search query normalization", () => {
  it("finds English autocomplete identifiers from Russian feature names without matching generic Auto", () => {
    for (const term of ["авто-пополнение", "авто пополнение", "автодополнение", "автозавершение"]) {
      expect(normalizeSearchConcepts(term)).toBe("autocomplete");
    }
    expect(normalizeSearchConcepts("Auto by default")).toBe("Auto by default");
    expect(normalizeSearchConcepts("auto completion" )).toBe("autocomplete");
    expect(normalizeSearchConcepts("SearchAutocompleteModel")).toBe("SearchAutocompleteModel");
  });

  it("uses a concise English concept for IDX without stripping unrelated Russian queries", () => {
    expect(indexSearchQuery("как работает авто-пополнение?")).toBe("autocomplete");
    expect(indexSearchQuery("автодополнение в Desktop")).toBe("autocomplete в Desktop");
    expect(indexSearchQuery("как работает индексация?")).toBe("как работает индексация?");
    expect(indexSearchQuery("auto routing")).toBe("auto routing");
  });
});
