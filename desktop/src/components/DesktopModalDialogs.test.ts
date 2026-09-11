import { describe, expect, it } from "vitest";
import commandSource from "./CommandPicker.svelte?raw";
import elicitationSource from "./ElicitationDialog.svelte?raw";
import modelSource from "./ModelThinkingPicker.svelte?raw";
import settingsSource from "./ProjectSettingsDialog.svelte?raw";

describe("desktop modal dialog lifecycle", () => {
  it("uses native modal dialogs with shared focus lifecycle", () => {
    for (const source of [commandSource, elicitationSource, modelSource, settingsSource]) {
      expect(source).toContain("<dialog");
      expect(source).toContain("activateModalDialog");
    }
  });

  it("uses semantic default actions for bounded form dialogs", () => {
    expect(elicitationSource).toContain("<form");
    expect(elicitationSource).toContain('type="submit"');
    expect(settingsSource).toContain("<form");
    expect(settingsSource).toContain('type="submit"');
  });

  it("keeps picker result rows outside the normal Tab sequence", () => {
    expect(commandSource).toContain('role="combobox"');
    expect(commandSource).toContain('tabindex="-1"');
    expect(modelSource).toContain('role="combobox"');
    expect(modelSource).toContain('tabindex="-1"');
  });
});
