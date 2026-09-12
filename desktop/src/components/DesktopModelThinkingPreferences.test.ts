import { describe, expect, it } from "vitest";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigSource from "../app/model-config.svelte.ts?raw";
import preferenceSource from "../app/model-preferences.svelte.ts?raw";
import overlaysSource from "./DesktopOverlays.svelte?raw";
import pickerSource from "./ModelThinkingPicker.svelte?raw";

describe("Desktop model thinking preferences", () => {
  it("loads the shared user preference map into the combined picker", () => {
    expect(preferenceSource).toContain("modelThinkingPreferencesFromPixConfig(document.content)");
    expect(overlaysViewModelSource).toContain("rememberedThinkingByModel: options.preferences.rememberedThinkingByModel");
    expect(overlaysViewModelSource).toContain("onVisibleModelsChange: options.preferences.saveVisibleModelRefs");
    expect(overlaysSource).toContain("<ModelThinkingPicker {...modelThinking} />");
    expect(pickerSource).toContain("Object.entries(rememberedThinkingByModel)");
    expect(pickerSource).toContain("thinkingByModel.set(modelRef, thinkingLevel)");
  });

  it("persists the effective thinking level after draft or session apply", () => {
    expect(preferenceSource).toContain("updateModelThinkingPreferenceInPixConfig(document.content, modelRef, thinkingLevel)");
    expect(modelConfigSource).toContain("await options.preferences.rememberThinkingPreference(modelRef, state.currentThinking)");
    expect(modelConfigSource).toContain("await options.preferences.rememberThinkingPreference(modelRef, applied.currentThinking)");
  });
});
