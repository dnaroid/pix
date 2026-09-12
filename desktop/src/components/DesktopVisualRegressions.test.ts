import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
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

    const openStart = appSource.indexOf("async function openModelThinkingPicker()");
    const openEnd = appSource.indexOf("function closeModelThinkingPicker()", openStart);
    const openPicker = appSource.slice(openStart, openEnd);
    expect(openPicker).not.toContain("promptRunning");

    const applyStart = appSource.indexOf("async function applyModelThinkingSelection(");
    const applyEnd = appSource.indexOf("async function enhancePromptDraft", applyStart);
    const applySelection = appSource.slice(applyStart, applyEnd);
    expect(applySelection).not.toContain("promptRunning");

    expect(appSource).toContain(
      "disabled={!canUseSession || changingConfig !== null || (draftSessionTabActive ? draftConfigOptions.length === 0 : !activeSessionRuntimeReady)}",
    );

    const commandStart = appSource.indexOf('case "session.modelThinking":');
    const commandEnd = appSource.indexOf('case "composer.focus":', commandStart);
    const commandAvailability = appSource.slice(commandStart, commandEnd);
    expect(commandAvailability).toContain("draftSessionTabActive ? draftConfigOptions.length > 0");
    expect(commandAvailability).not.toContain("promptRunning");
  });

  it("suppresses browser-native number and textarea chrome in generated settings", () => {
    expect(settingsSource).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(settingsSource).toContain("[appearance:textfield]");
    expect(settingsSource).not.toContain("resize-y");
  });
});
