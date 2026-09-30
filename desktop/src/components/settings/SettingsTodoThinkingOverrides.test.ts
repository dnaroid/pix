import { describe, expect, it } from "vitest";
import editorSource from "./ToolsSuiteSettingsEditor.svelte?raw";
import overridesSource from "./SettingsTodoThinkingOverrides.svelte?raw";
import selectSource from "./SettingsSelect.svelte?raw";

describe("Todo thinking overrides settings UI", () => {
  it("uses a structured pattern/level editor instead of the generic JSON textarea", () => {
    expect(editorSource).toContain("SettingsTodoThinkingOverrides");
    expect(editorSource).not.toContain('SettingsJsonValue value={json(["todoThinkingOverrides"])}');
    expect(overridesSource).not.toContain(">Model / pattern<");
    expect(overridesSource).toContain('bound === "min" ? "Min" : "Max"');
    expect(overridesSource).toContain("todoThinkingRangeError");
    expect(overridesSource).toContain("Add todo thinking override");
  });

  it("keeps wildcard, inheritance, and configured-value affordances visible", () => {
    expect(overridesSource).toContain("provider/model or wildcard");
    expect(overridesSource).toContain("No override");
    expect(overridesSource).toContain("Restore inherited value");
    expect(overridesSource).toContain("SettingsSelect");
  });

  it("reuses the provider-icon selector with custom patterns and two-line rows", () => {
    expect(overridesSource.match(/<SettingsModelSelect/g)).toHaveLength(2);
    expect(overridesSource.match(/\n\s+allowCustom\n/g)).toHaveLength(2);
    expect(overridesSource).toContain("disabled={row.inherited}");
    expect(overridesSource).toContain('class="flex items-center gap-1.5"');
    expect(overridesSource).not.toContain("w-24");
    expect(overridesSource).not.toContain("<datalist");
  });

  it("separates two-line pairs and keeps add and hints out of the default layout", () => {
    expect(overridesSource).toContain('class="divide-y divide-sidebar-border/50"');
    expect(overridesSource).toContain('<details class="min-w-0 flex-1">');
    expect(overridesSource).toContain("<summary");
    expect(overridesSource).not.toContain("<details open");
    expect(overridesSource).toContain('title={row.inherited ? inheritedLabel(row) : undefined}');
    expect(overridesSource).toContain('aria-label="About todo thinking limits"');
    expect(overridesSource).toContain('class="flex min-w-0 flex-1 items-center gap-1.5"');
    expect(editorSource).not.toContain('description="Choose Min / Max');
  });

  it("resets rejected bounds without remounting and losing keyboard focus", () => {
    expect(overridesSource).not.toContain("{#key rowError");
    expect(overridesSource).toContain("return false;");
    expect(selectSource).toContain("if (onChange(select.value) === false) select.value = previousValue;");
  });
});
