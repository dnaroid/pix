import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import modelPickerStateSource from "../app/model-picker-state.svelte.ts?raw";
import composerSource from "./PromptComposer.svelte?raw";
import diffViewSource from "./DiffView.svelte?raw";
import elicitationSource from "./ElicitationDialog.svelte?raw";
import idxSource from "./IdxPanel.svelte?raw";
import packageScriptsSource from "./PackageScriptsPanel.svelte?raw";
import sessionTodosSource from "./SessionTodosPanel.svelte?raw";
import settingsSource from "./SettingsPanel.svelte?raw";
import statusSource from "./StatusBar.svelte?raw";

describe("desktop visual regressions", () => {
  it("keeps the composer placeholder on one visual line", () => {
    expect(composerSource).toContain('"Ask Pix anything…"');
    expect(composerSource).toContain("[&::placeholder]:whitespace-nowrap");
  });

  it("normalizes modal elicitation select and action buttons", () => {
    expect(elicitationSource).toContain("appearance-none");
    expect(elicitationSource).toContain("ChevronDown");
    expect(elicitationSource).toContain("focus:border-ring");
    expect(elicitationSource).not.toContain("border-primary bg-primary");
    expect(elicitationSource).toContain("h-8 rounded-md px-3 text-xs font-medium text-muted-foreground");
    expect(elicitationSource).toContain("inline-flex h-8 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground");
  });

  it("uses semantic error and success tokens in diff view instead of primary accent", () => {
    expect(diffViewSource).not.toContain("var(--primary)");
    expect(diffViewSource).toContain("var(--tool-error)");
    expect(diffViewSource).toContain("var(--tool-success)");
    expect(diffViewSource).toContain("var(--tool-info)");
  });

  it("keeps global focus-visible reset in base layer so component utilities win", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const filePath = path.resolve(__dirname, "../styles.css");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toMatch(/@layer\s+base\s*\{[^}]*:focus-visible\s*\{[^}]*outline:\s*none;[^}]*\}\s*\}/);
  });

  it("preserves visible focus ring on idx context input controls", () => {
    expect(idxSource).toContain('bind:value={queryState.contextMaxSpecs}');
    expect(idxSource).toContain('bind:value={queryState.contextMaxCode}');
    expect(idxSource).toContain('bind:value={queryState.contextMaxTests}');
    expect(idxSource).toContain('focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="20" aria-label="Maximum context specs"');
    expect(idxSource).toContain('focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="30" aria-label="Maximum context code files"');
    expect(idxSource).toContain('focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="20" aria-label="Maximum context tests"');
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

  it("enforces accessible minimum font size across panels and outputs", () => {
    expect(idxSource).not.toMatch(/text-\[[6789]px\]/);
    expect(idxSource).toContain('className="text-[11px] leading-[1.55]"');
    expect(settingsSource).not.toMatch(/text-\[[6789]px\]/);
    expect(packageScriptsSource).not.toMatch(/text-\[[6789]px\]/);
    expect(sessionTodosSource).not.toMatch(/text-\[[6789]px\]/);
    expect(sessionTodosSource).toContain("text-[11px] leading-4 text-muted-foreground");
  });
});
