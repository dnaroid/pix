import { describe, expect, it } from "vitest";

const components = import.meta.glob("../**/*.svelte", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

// Existing migration debt, not permission to add native selects or wrappers.
// Remove entries as their dropdowns migrate; never grow this inventory for convenience.
// All legacy native selects have migrated to the Pix dropdown; keep this empty.
const legacySelects: Record<string, number> = {};

describe("Desktop design contract: Pix dropdowns", () => {
  it("does not introduce native selects beyond the existing migration debt", () => {
    for (const [filename, source] of Object.entries(components)) {
      const relative = filename.replace(/^(?:\.\.\/components\/|\.\/)/u, "");
      const count = [...source.matchAll(/<select\b/gu)].length;
      expect(count, `${filename}: use a Pix popup/listbox (DESIGN.md §11), not a native select`).toBeLessThanOrEqual(legacySelects[relative] ?? 0);
    }
  });

  it("does not spread the legacy native-select settings wrapper to new surfaces", () => {
    for (const [filename, source] of Object.entries(components)) {
      const relative = filename.replace(/^(?:\.\.\/components\/|\.\/)/u, "");
      if (!relative.startsWith("settings/")) {
        expect(source, `${filename}: SettingsSelect is native migration debt`).not.toMatch(/<SettingsSelect\b/u);
      }
    }
  });
});
