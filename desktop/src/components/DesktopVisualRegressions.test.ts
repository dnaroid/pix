import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import statusBarViewModelSource from "../app/desktop-status-bar-view-model.svelte.ts?raw";
import modelDraftConfigSource from "../app/model-draft-config.svelte.ts?raw";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import modelPickerStateSource from "../app/model-picker-state.svelte.ts?raw";
import modelThinkingPickerSource from "./ModelThinkingPicker.svelte?raw";
import composerSource from "./PromptComposer.svelte?raw";
import diffViewSource from "./DiffView.svelte?raw";
import elicitationSource from "./ElicitationDialog.svelte?raw";
import gitCommitComposerSource from "./GitCommitComposer.svelte?raw";
import idxSource from "./IdxPanel.svelte?raw";
import packageScriptsSource from "./PackageScriptsPanel.svelte?raw";
import runtimeStatusSource from "./RuntimeStatusBarItems.svelte?raw";
import dcpContextPanelSource from "./DcpContextPanel.svelte?raw";
import sessionSubagentsSource from "./SessionSubagentsPanel.svelte?raw";
import sessionTodosSource from "./SessionTodosPanel.svelte?raw";
import settingsSource from "./SettingsPanel.svelte?raw";
import desktopSettingsEditorSource from "./settings/DesktopSettingsEditor.svelte?raw";
import settingsModelListSource from "./settings/SettingsModelList.svelte?raw";
import settingsModelRoutingTiersSource from "./settings/SettingsModelRoutingTiers.svelte?raw";
import settingsModelSelectSource from "./settings/SettingsModelSelect.svelte?raw";
import settingsModelVisibilitySource from "./settings/SettingsModelVisibility.svelte?raw";
import settingsNumberInputSource from "./settings/SettingsNumberInput.svelte?raw";
import settingsSectionNavSource from "./settings/SettingsSectionNav.svelte?raw";
import statusSource from "./StatusBar.svelte?raw";
import markdownSource from "./MarkdownText.svelte?raw";
import terminalSource from "./TerminalView.svelte?raw";
import tauriLibSource from "../../src-tauri/src/lib.rs?raw";
import toolResultSource from "./ToolResult.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("desktop visual regressions", () => {
  it("keeps the composer placeholder on one visual line", () => {
    expect(composerSource).toContain('"Ask Pix anything…"');
    expect(composerSource).toContain("[&::placeholder]:whitespace-nowrap");
  });

  it("hides native textarea resize handles and auto-sizes the commit message", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const stylesPath = path.resolve(__dirname, "../styles.css");
    const styles = fs.readFileSync(stylesPath, "utf-8");

    expect(styles).toMatch(/textarea\s*\{\s*resize:\s*none;\s*\}/);
    expect(gitCommitComposerSource).toContain("autosizeTextarea(messageTextarea, { minHeight: 64, maxHeight: 160 })");
    expect(gitCommitComposerSource).not.toContain("resize-y");
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

  it("uses the ready ACP dot for active-conversation work without a transcript-bottom spinner", () => {
    expect(statusSource).toContain('status === "ready" && promptRunning');
    expect(statusSource).toContain('"bg-primary connection-activity"');
    expect(statusSource).toContain('"ACP ready; active conversation working"');
    expect(statusSource).toContain("@media (prefers-reduced-motion: reduce)");
    expect(statusSource).toContain(".connection-activity { animation: none; }");

    expect(transcriptSource).not.toContain('aria-label="Pix is working"');
    expect(transcriptSource).not.toContain('LoaderCircle from "@lucide/svelte/icons/loader-circle"');
    expect(transcriptSource).toContain("promptRunning: () => promptRunning");
    expect(transcriptSource).toContain("disabled={promptRunning || operationRunning}");
  });

  it("keeps the jump-to-latest arrow translucent over transcript content", () => {
    expect(transcriptSource).toContain("bg-panel-strong/70");
    expect(transcriptSource).toContain("backdrop-blur-sm");
    expect(transcriptSource).toContain("hover:bg-panel-hover/90");
  });

  it("keeps project and Git branch between context and usage status chrome", () => {
    const context = runtimeStatusSource.indexOf("title={contextTitle()}");
    const workspace = runtimeStatusSource.indexOf("data-runtime-workspace");
    const usage = runtimeStatusSource.indexOf('title="Refresh model usage limits"');
    expect(context).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(context);
    expect(usage).toBeGreaterThan(workspace);
    expect(runtimeStatusSource).toContain("({workspaceBranch})");
    expect(runtimeStatusSource).toContain("runtime-workspace-name");
    expect(runtimeStatusSource).toContain("--runtime-workspace-color");
    expect(runtimeStatusSource).toContain('text-muted-foreground">({workspaceBranch})');
    expect(runtimeStatusSource).toContain("title={workspacePath ?? workspaceName}");
    expect(runtimeStatusSource).toContain("{#if status || workspaceName}");
  });

  it("keeps workspace identity and selected-model limits visible for UI-only drafts", () => {
    expect(statusBarViewModelSource).toContain("runtimeStatus = options.modelConfig.draftRuntimeStatus");
    expect(statusBarViewModelSource).toContain("modelUsageRefreshing = options.modelConfig.draftModelUsageRefreshing");
    expect(statusBarViewModelSource).toContain("options.modelConfig.refreshDraftModelUsage()");
    expect(modelDraftConfigSource).toContain("void refreshUsage(modelRef, state.currentThinking, true)");
    expect(modelDraftConfigSource).not.toContain("refreshModelUsage: true");
    expect(modelDraftConfigSource).toContain("}, true);");
  });

  it("shows absolute context and live DCP token savings in the hover title without repeating percent", () => {
    expect(runtimeStatusSource).toContain("status?.dcpTokensSaved");
    expect(runtimeStatusSource).toContain("DCP saved ~");
    expect(runtimeStatusSource).toContain("Context ${formatCompactTokens(context.tokens)} / ${formatCompactTokens(context.contextWindow)} tokens");
    expect(runtimeStatusSource).not.toContain("Context ${Math.round(context.percent)}%");
  });

  it("keeps DCP context visualization semantically separated in the Session inspector", () => {
    expect(dcpContextPanelSource).toContain("Context token-volume capacity map");
    expect(dcpContextPanelSource).not.toContain("DcpPreparedMap");
    expect(dcpContextPanelSource).toContain("grouped capacity shares, not message positions");
    expect(dcpContextPanelSource).toContain("Advisory compression candidates, not permission to delete");
    expect(dcpContextPanelSource).toContain("DCP category estimates are unavailable.");
    expect(dcpContextPanelSource).toContain("It is not measured commit gain or a billing counter.");
    expect(dcpContextPanelSource).toContain("Old unmeasured commits remain unknown");
    expect(dcpContextPanelSource).not.toContain("Open DCP statistics from Context in the status bar");
  });

  it("keeps Session inspector sections as independently persistent native accordions", () => {
    for (const source of [dcpContextPanelSource, sessionSubagentsSource, sessionTodosSource]) {
      expect(source).toContain('<details');
      expect(source).toContain("<summary");
      expect(source).toContain("[&::-webkit-details-marker]:hidden");
      expect(source).not.toContain("bind:open");
      expect(source).not.toContain("open={$derived");
    }

    expect(dcpContextPanelSource).toContain('<details class="group border-b border-border">');
    expect(dcpContextPanelSource).not.toContain('<details class="group border-b border-border" open>');
    for (const source of [sessionSubagentsSource, sessionTodosSource]) {
      expect(source).toContain('ontoggle={noteToggle}');
      expect(source).toContain('receivedInitialSnapshot || snapshot === undefined');
      expect(source).toContain('if (!manuallyToggled) applyInitialOpenState()');
    }

    expect(sessionTodosSource).toContain("{summary.completedTodos}/{summary.totalTodos} tasks");
    expect(sessionTodosSource).toContain('aria-label="Clear session plan"');
    expect(sessionTodosSource).toContain("onclick={() => { void clearTodos(); }}");
    // A header action inside details would disappear when the accordion closes.
    expect(sessionTodosSource.indexOf('aria-label="Clear session plan"')).toBeGreaterThan(sessionTodosSource.indexOf("</details>"));
    expect(sessionTodosSource).toContain("disabled={!canClearTodos || clearingTodos || rows.length === 0}");
    expect(sessionSubagentsSource).toContain("{activeCount} active");
    const dcpSummary = dcpContextPanelSource.slice(
      dcpContextPanelSource.indexOf("<summary"),
      dcpContextPanelSource.indexOf("</summary>"),
    );
    expect(dcpSummary).toContain("~{formatCompactTokens(view.liveTokensSaved)}");
    expect(dcpSummary).not.toContain("occupied");
    expect(dcpSummary).not.toContain("saved");
    expect(dcpSummary).not.toContain("unknown");
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

  it("exposes Auto in live model pickers and moves that choice to a new routed draft", () => {
    expect(modelPickerStateSource).toContain("await draftConfig.refreshRoutingAvailability()");
    expect(overlaysViewModelSource).toContain("options.modelConfig.pickerConfigOptions(options.displayedConfigOptions())");
    expect(modelConfigActionsSource).toContain('if (!picker.draft && modelRef === AUTO_MODEL_REF)');
    expect(modelConfigActionsSource).toContain("await options.openDraftSessionTab()");
    expect(modelConfigActionsSource).toContain('draftConfig.applySelection(AUTO_MODEL_REF, "off")');
  });

  it("uses curated settings editors and keeps native number chrome suppressed", () => {
    expect(settingsSource).toContain('import DesktopSettingsEditor from "./settings/DesktopSettingsEditor.svelte"');
    expect(settingsSource).toContain('import ToolsSuiteSettingsEditor from "./settings/ToolsSuiteSettingsEditor.svelte"');
    expect(settingsSource).toContain("Advanced JSONC");
    expect(settingsSource).not.toContain("settingsSections");
    expect(settingsNumberInputSource).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(settingsNumberInputSource).toContain("[appearance:textfield]");
    expect(settingsSource).not.toContain("resize-y");
  });

  it("keeps sidebar settings navigation compact without horizontally scrolling tabs", () => {
    expect(settingsSectionNavSource).toContain('aria-label="Settings section"');
    expect(settingsSectionNavSource).toContain("<select");
    expect(settingsSectionNavSource).not.toContain("overflow-x-auto");
    expect(settingsSectionNavSource).not.toContain("aria-current");
  });

  it("uses the live model catalog instead of free-form model text fields", () => {
    expect(settingsSource).toContain("modelThinkingConfigState(configOptions).models");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelSelect");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelList");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelVisibility");
    expect(desktopSettingsEditorSource).not.toContain('placeholder="provider/model"');
    expect(desktopSettingsEditorSource).not.toContain("SettingsStringList");
    expect(desktopSettingsEditorSource).not.toContain('label="Remembered thinking by model"');
    expect(settingsModelSelectSource).toContain("searchSettingsModelOptions");
    expect(settingsModelSelectSource).toContain('role="combobox"');
    expect(settingsModelSelectSource).toContain('placeholder="Filter models…"');
    expect(settingsModelListSource).toContain("availableToAdd");
    expect(settingsModelListSource).toContain("<SettingsModelSelect");
    expect(settingsModelListSource).not.toContain("<select");
    expect(settingsModelVisibilitySource).toContain("Choose visible models");
    expect(settingsModelVisibilitySource).toContain("searchSettingsModels");
    expect(desktopSettingsEditorSource).toContain('ariaLabel="Review model"');
    expect(desktopSettingsEditorSource).toContain('ariaLabel="Commit message model"');
  });

  it("exposes semantic first-prompt model routing in curated Desktop settings", () => {
    expect(desktopSettingsEditorSource).toContain('label="Automatic model routing"');
    expect(desktopSettingsEditorSource).toContain('label="Auto by default"');
    expect(desktopSettingsEditorSource).toContain('label="Router model"');
    expect(desktopSettingsEditorSource).toContain('label="Router fallbacks"');
    expect(desktopSettingsEditorSource).toContain('label="Routing fallback tier"');
    expect(desktopSettingsEditorSource).toContain('label="Routing tiers"');
    expect(desktopSettingsEditorSource).toContain("<SettingsModelRoutingTiers");
    expect(settingsModelRoutingTiersSource).toContain('placeholder="semantic id"');
    expect(settingsModelRoutingTiersSource).toContain("<SettingsModelSelect");
    expect(settingsModelRoutingTiersSource).toContain("options={THINKING_OPTIONS}");
  });

  it("keeps unresolved Auto at the top without a fake status-bar thinking level", () => {
    expect(statusSource).toContain('modelThinking.currentModel.ref !== AUTO_MODEL_REF');
    expect(modelThinkingPickerSource).toContain("const auto = visibilityMode ? undefined : pickerModels.find");
    expect(modelThinkingPickerSource).toContain("return auto ? [auto, ...filtered] : filtered");
  });

  it("keeps Desktop voice settings to the API key, language code, and speech model", () => {
    expect(desktopSettingsEditorSource).toContain('label="Deepgram API key"');
    expect(desktopSettingsEditorSource).toContain('label="Language"');
    expect(desktopSettingsEditorSource).toContain('label="Speech model"');
    expect(desktopSettingsEditorSource).not.toContain('label="Languages"');
    expect(desktopSettingsEditorSource).not.toContain("deepgramLanguage");
    expect(desktopSettingsEditorSource).not.toContain('"label": "English"');
    expect(desktopSettingsEditorSource).toContain("LANGUAGE_OPTIONS");
    expect(desktopSettingsEditorSource).toContain("SPEECH_MODEL_OPTIONS");
  });

  it("keeps package terminals interactive, scrollable, bounded, and script rows compact", () => {
    expect(terminalSource).toContain("const TERMINAL_SCROLLBACK_LINES = 5_000;");
    expect(terminalSource).toContain('cursorStyle: "bar"');
    expect(terminalSource).toContain("cursorWidth: 2");
    expect(terminalSource).toContain('cursorInactiveStyle: "none"');
    expect(terminalSource).toContain("terminal.options.cursorBlink = false");
    expect(terminalSource).toContain("data-terminal-caret");
    expect(terminalSource).toContain("currentTerminal.buffer.active.cursorX");
    expect(terminalSource).toContain("currentTerminal.buffer.active.cursorY");
    expect(terminalSource).toContain("caretSync.schedule()");
    expect(terminalSource).toContain("caretSync.cancel()");
    expect(terminalSource).toContain("bind:this={scrollTrack}");
    expect(terminalSource).toContain("scrollbarVisible");
    expect(terminalSource).toContain("currentTerminal.scrollToLine");
    expect(terminalSource).toContain("scrollbar-width: none");
    expect(tauriLibSource).toContain('command.arg("-f")');
    expect(tauriLibSource).toContain('command.env("PROMPT", "pix:%1~ $ ")');
    expect(packageScriptsSource).toContain("{script.name}");
    expect(packageScriptsSource).not.toContain("{script.command}");
    expect(packageScriptsSource).not.toContain("title={script.command}");
  });

  it("keeps desktop typography on the compact IDE scale with a 12px minimum", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const componentsDir = path.resolve(__dirname);
    const componentSources = fs.readdirSync(componentsDir)
      .filter((name: string) => name.endsWith(".svelte"))
      .map((name: string) => [name, fs.readFileSync(path.join(componentsDir, name), "utf-8")] as const);

    for (const [name, source] of componentSources) {
      expect(source, `${name} must not use arbitrary font utilities below 12px`).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
      expect(source, `${name} must not hard-code CSS font sizes below 12px`).not.toMatch(/font-size:\s*(?:[0-9]|1[01])px/);
      expect(source, `${name} must not configure runtime font sizes below 12px`).not.toMatch(/fontSize:\s*(?:[0-9]|1[01])(?:\D|$)/);
    }

    expect(idxSource).toContain('className="text-xs leading-[1.55]"');
    expect(sessionTodosSource).toContain("text-xs leading-4 text-muted-foreground");
    expect(toolResultSource).toContain("font-size: 12px");
    expect(terminalSource).toContain("fontSize: 12");
    expect(markdownSource).not.toMatch(/font-size:\s+0\.(?:85|88|9|92|94)em;/);
    expect(markdownSource).toContain("max(0.85em, 0.75rem)");
  });
});
