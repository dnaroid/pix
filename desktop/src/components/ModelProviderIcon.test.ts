import { describe, expect, it } from "vitest";
import source from "./ModelProviderIcon.svelte?raw";

describe("ModelProviderIcon", () => {
  it("renders serving-provider brands without fake letter icons", () => {
    expect(source).toContain("modelProviderBrand(provider)");
    expect(source).toContain('brand === "openrouter"');
    expect(source).toContain("OPENROUTER_ICON_PATH");
    expect(source).toContain('brand === "ollama"');
    expect(source).toContain("OLLAMA_ICON_PATH");
    expect(source).not.toContain("fallbackLabel");
  });
});
