import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import pickerSource from "./ModelThinkingPicker.svelte?raw";

describe("Desktop model thinking preferences", () => {
  it("loads the shared user preference map into the combined picker", () => {
    expect(appSource).toContain("modelThinkingPreferencesFromPixConfig(document.content)");
    expect(appSource).toContain("{rememberedThinkingByModel}");
    expect(pickerSource).toContain("Object.entries(rememberedThinkingByModel)");
    expect(pickerSource).toContain("thinkingByModel.set(modelRef, thinkingLevel)");
  });

  it("persists the effective thinking level after draft or session apply", () => {
    expect(appSource).toContain("updateModelThinkingPreferenceInPixConfig(document.content, modelRef, thinkingLevel)");
    expect(appSource).toContain("await rememberModelThinkingPreference(modelRef, state.currentThinking)");
    expect(appSource).toContain("await rememberModelThinkingPreference(modelRef, applied.currentThinking)");
  });
});
