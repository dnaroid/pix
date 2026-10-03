import { describe, expect, it } from "vitest";
import pickerSource from "./ModelThinkingPicker.svelte?raw";

describe("ModelThinkingPicker staged selection", () => {
  it("keeps row selection changes out of the search-reset effect dependencies", () => {
    expect(pickerSource).toContain('import { onMount, tick, untrack } from "svelte";');
    expect(pickerSource).toContain("untrack(() => {");
    expect(pickerSource).toContain("if (first && !visibilityMode) stageModel(first);");
  });

  it("uses the selected model capability list for the thinking controls", () => {
    expect(pickerSource).toContain('selectedModel?.thinkingLevels ?? ["off"]');
    expect(pickerSource).toContain("selectedModel?.thinkingLevels.includes(level)");
    expect(pickerSource).toContain("rememberedThinkingByModel = {}");
    expect(pickerSource).toContain("thinkingByModel.set(modelRef, thinkingLevel)");
    expect(pickerSource).toContain("thinkingByModel.get(model.ref) ?? config.currentThinking");
    expect(pickerSource).toContain("model.thinkingLevels");
  });

  it("preserves the current row during initialization and empty search", () => {
    expect(pickerSource).toContain("const initialModel = config.currentModel ?? config.models[0]");
    expect(pickerSource).toContain("selectedIndex = pickerModelIndex(filteredModels, selectedModelRef, query, visibilityMode)");
  });

  it("handles effort arrows throughout the dialog without double-stepping radio events", () => {
    expect(pickerSource).toContain("if (event.defaultPrevented) return;");
    expect(pickerSource).toContain('!visibilityMode && (event.key === "ArrowLeft" || event.key === "ArrowRight")');
    expect(pickerSource).toContain('moveThinking(event.key === "ArrowRight" ? 1 : -1, true)');
    expect(pickerSource).toContain("activateModalDialog(dialogElement, () => search, restoreFocus)");
    expect(pickerSource).not.toContain("{:else if model.ref === selectedModelRef}");
    expect(pickerSource).not.toContain("!dirty || disabled");
    expect(pickerSource).toContain("if (!dirty) {\n      onClose();");
  });

  it("confirms the staged selection with Enter from model rows in select mode only", () => {
    expect(pickerSource).toContain("function handleModelKeydown(event: KeyboardEvent): void {");
    expect(pickerSource).toContain('if (visibilityMode || event.key !== "Enter") return;');
    expect(pickerSource).toContain("void applySelection();");
    expect(pickerSource).toContain("onkeydown={(event) => handleModelKeydown(event)}");
    // Manage mode keeps the native row activation (visibility toggle).
    expect(pickerSource).toContain("if (visibilityMode) void toggleModelVisibility(model);");
  });
});
