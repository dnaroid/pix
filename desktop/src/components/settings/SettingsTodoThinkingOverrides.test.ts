import { describe, expect, it } from "vitest";
import editorSource from "./ToolsSuiteSettingsEditor.svelte?raw";
import overridesSource from "./SettingsTodoThinkingOverrides.svelte?raw";

describe("Todo thinking overrides settings UI", () => {
  it("uses a structured pattern/level editor instead of the generic JSON textarea", () => {
    expect(editorSource).toContain("SettingsTodoThinkingOverrides");
    expect(editorSource).not.toContain('SettingsJsonValue value={json(["todoThinkingOverrides"])}');
    expect(overridesSource).toContain("Model / pattern");
    expect(overridesSource).toContain("Thinking");
    expect(overridesSource).toContain("Add todo thinking override");
  });

  it("keeps wildcard, inheritance, and configured-value affordances visible", () => {
    expect(overridesSource).toContain("provider/model or wildcard");
    expect(overridesSource).toContain("No override");
    expect(overridesSource).toContain("Restore inherited value");
    expect(overridesSource).toContain("SettingsSelect");
  });
});
