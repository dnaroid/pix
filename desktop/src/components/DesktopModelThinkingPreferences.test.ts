import { describe, expect, it } from "vitest";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import preferenceSource from "../app/model-preferences.svelte.ts?raw";
import overlaysSource from "./DesktopOverlays.svelte?raw";
import pickerSource from "./ModelThinkingPicker.svelte?raw";

describe("Desktop model thinking preferences", () => {
  it("loads the Desktop-only user preference map into the combined picker", () => {
    expect(preferenceSource).toContain('read_user_config", { kind: "desktop" }');
    expect(preferenceSource).not.toContain('read_user_config", { kind: "pix" }');
    expect(preferenceSource).toContain("modelThinkingPreferencesFromPixConfig(document.content)");
    expect(preferenceSource).toContain("modelDefaultSelectionFromPixConfig(document.content)");
    expect(overlaysViewModelSource).toContain("rememberedThinkingByModel: options.preferences.rememberedThinkingByModel");
    expect(overlaysViewModelSource).toContain("defaultSelection: options.preferences.defaultSelection");
    expect(overlaysViewModelSource).toContain("onSetDefault: options.preferences.saveDefaultSelection");
    expect(overlaysViewModelSource).toContain("onVisibleModelsChange: options.preferences.saveVisibleModelRefs");
    expect(overlaysSource).toContain("<ModelThinkingPicker {...modelThinking} />");
    expect(pickerSource).toContain("Object.entries(rememberedThinkingByModel)");
    expect(pickerSource).toContain("thinkingByModel.set(modelRef, thinkingLevel)");
  });

  it("persists the effective thinking level after draft or session apply", () => {
    expect(preferenceSource).toContain("updateModelThinkingPreferenceInPixConfig(document.content, modelRef, thinkingLevel)");
    expect(modelConfigActionsSource).toContain("await options.preferences.rememberThinkingPreference(modelRef, currentThinking)");
    expect(modelConfigActionsSource).toContain("await options.preferences.rememberThinkingPreference(modelRef, applied.currentThinking)");
  });

  it("lets the staged model and thinking or Auto become the new-conversation default", () => {
    expect(preferenceSource).toContain("updateModelDefaultSelectionInPixConfig(document.content, selection)");
    expect(pickerSource).toContain("Set default");
    expect(pickerSource).toContain("selectedAuto");
    expect(pickerSource).toContain('? { kind: "auto" }');
    expect(pickerSource).toContain('kind: "model", modelRef: selectedModel.ref, thinking: selectedThinking');
    expect(pickerSource).toContain("current · default");
  });
});
