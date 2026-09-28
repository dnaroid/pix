import { describe, expect, it } from "vitest";
import source from "./ModelProviderIcon.svelte?raw";

describe("ModelProviderIcon", () => {
  it("renders a fallback mark instead of reserving an empty provider slot", () => {
    expect(source).toContain("fallbackLabel");
    expect(source).toContain('{:else if fallbackLabel}');
    expect(source).toContain("{fallbackLabel}");
  });
});
