import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import modelPickerStateSource from "../app/model-picker-state.svelte.ts?raw";
import composerSource from "./PromptComposer.svelte?raw";
import settingsSource from "./SettingsPanel.svelte?raw";
import statusSource from "./StatusBar.svelte?raw";

describe("desktop visual regressions", () => {
  it("keeps the composer placeholder on one visual line", () => {
    expect(composerSource).toContain('"Ask Pix anything…"');
    expect(composerSource).toContain("[&::placeholder]:whitespace-nowrap");
  });

  it("renders Session as the final icon-only status action", () => {
    expect(statusSource.indexOf('title="Jump to user message"')).toBeLessThan(
      statusSource.indexOf("title={`Session activity · ${activityLabel}`}"),
    );
    expect(statusSource).not.toContain('>Session</span>');
    expect(statusSource).toContain('sessionActivityOpen ? "text-foreground" : activityToneClass()');
  });

  it("keeps the model and thinking selector available while a prompt is running", () => {
    expect(statusSource).toContain('disabled={!canConfigure || changingConfig !== null}');

    const openStart = modelPickerStateSource.indexOf("async function show()");
    const openEnd = modelPickerStateSource.indexOf("return {", openStart);
    const openPicker = modelPickerStateSource.slice(openStart, openEnd);
    expect(openPicker).not.toContain("promptRunning");

    const applyStart = modelConfigActionsSource.indexOf("async function applySelection(");
    const applyEnd = modelConfigActionsSource.indexOf("async function setConfigValue", applyStart);
    const applySelection = modelConfigActionsSource.slice(applyStart, applyEnd);
    expect(applySelection).not.toContain("promptRunning");

    expect(overlaysViewModelSource).toContain("disabled: !options.canUseSession()");
    expect(overlaysViewModelSource).toContain("|| options.changingConfig() !== null");
    expect(overlaysViewModelSource).toContain("? !options.draftConfigAvailable()");
    expect(overlaysViewModelSource).toContain(": !options.activeSessionRuntimeReady())");
    expect(overlaysViewModelSource).not.toContain("promptRunning");

    const commandStart = commandSource.indexOf('case "session.modelThinking":');
    const commandEnd = commandSource.indexOf('case "composer.focus":', commandStart);
    const commandAvailability = commandSource.slice(commandStart, commandEnd);
    expect(commandAvailability).toContain("options.draftSessionTabActive()");
    expect(commandAvailability).toContain("options.draftConfigAvailable()");
    expect(commandAvailability).not.toContain("promptRunning");
  });

  it("suppresses browser-native number and textarea chrome in generated settings", () => {
    expect(settingsSource).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(settingsSource).toContain("[appearance:textfield]");
    expect(settingsSource).not.toContain("resize-y");
  });
});
