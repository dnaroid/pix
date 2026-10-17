import { describe, expect, it } from "vitest";
import source from "./ModelSetupDialog.svelte?raw";

describe("ModelSetupDialog", () => {
  it("uses the Pix listbox, never a native select, and persists dismissal", () => {
    expect(source).toContain("SettingsModelSelect");
    expect(source).not.toContain("<select");
    expect(source).toContain("DISMISSED_KEY");
    expect(source).toContain("next.configured");
  });
});
