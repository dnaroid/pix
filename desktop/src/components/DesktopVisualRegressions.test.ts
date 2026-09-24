import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import statusBarViewModelSource from "../app/desktop-status-bar-view-model.svelte.ts?raw";
import workbenchPropBuildersSource from "../app/desktop-workbench-prop-builders.ts?raw";
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
import sessionInspectorSource from "./SessionInspector.svelte?raw";
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
import transcriptActivityGroupSource from "./TranscriptActivityGroup.svelte?raw";
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
    expect(elicitationSource).not.toContain("resize-y");
  });

  it("normalizes modal elicitation controls and action buttons", () => {
    expect(elicitationSource).toContain("appearance-none");
    expect(elicitationSource).toContain('import Check from "@lucide/svelte/icons/check"');
    expect(elicitationSource).toContain("ChevronDown");
    expect(elicitationSource).toContain("focus:border-ring");
    expect(elicitationSource).toContain("checked:border-primary checked:bg-primary");
    expect(elicitationSource).toContain("peer-checked:opacity-100");
    expect(elicitationSource).toContain("field.label.trim() === message.trim()");
    expect(elicitationSource).not.toContain("accent-primary");
    expect(elicitationSource).not.toContain("border-primary bg-primary");
    expect(elicitationSource).toContain("h-8 rounded-md px-3 text-xs font-medium text-muted-foreground");
    expect(elicitationSource).toContain("inline-flex h-8 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground");
  });

  it("keeps text-file Preview selectable for native copy without making desktop chrome selectable", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const stylesPath = path.resolve(__dirname, "../styles.css");
    const styles = fs.readFileSync(stylesPath, "utf-8");

    expect(styles).toContain(".transcript-pane,\n.preview-text-surface,");
    expect(styles).toContain("user-select: text;");
    expect(styles).toContain("user-select: none;");
    expect(styles).toContain("cursor: default;");
    expect(styles).toContain(".select-text,");
    expect(styles).toContain("cursor: text;");
  });

  it("uses semantic error and success tokens in diff view instead of primary accent", () => {
    expect(diffViewSource).not.toContain("var(--primary)");
    expect(diffViewSource).toContain("var(--tool-error)");
    expect(diffViewSource).toContain("var(--tool-success)");
    expect(diffViewSource).toContain("var(--tool-info)");
  });

  it("keeps tool diagnostics on child rows instead of promoting them to the activity-group summary", () => {
    expect(transcriptActivityGroupSource).toContain("attention={toolAttention}");
    expect(transcriptActivityGroupSource).toContain("<ToolStatusIcon status={item.status} lifecycleOnly class=");
    expect(transcriptActivityGroupSource).not.toContain("toolGroupAttention");
  });

  it("keeps active thinking emphasis in the activity header only", () => {
    expect(transcriptActivityGroupSource).toContain('data-activity-active={label.active}');
    expect(transcriptActivityGroupSource).toContain('class={label.active ? "font-medium text-primary" : "font-normal text-muted-foreground/85"}');
    expect(transcriptActivityGroupSource).toContain('<Brain class="h-3 w-3 shrink-0 text-muted-foreground/65"');
    expect(transcriptActivityGroupSource).toContain('data-activity-thought-label class="text-muted-foreground/85"');
  });

  it("uses one restrained global keyboard-focus treatment across Desktop", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const filePath = path.resolve(__dirname, "../styles.css");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("outline: 1px solid color-mix(in srgb, var(--ring) 42%, transparent);");
    expect(content).toContain("outline-offset: -2px;");
    expect(content).toContain("--tw-ring-shadow: 0 0 #0000;");
    expect(content).toContain("outline-color: color-mix(in srgb, var(--ring) 64%, transparent);");
    expect(content).not.toMatch(/@layer\s+base\s*\{[^}]*:focus-visible\s*\{[^}]*outline:\s*none;/);
    expect(markdownSource).not.toContain("outline: 2px solid var(--ring)");
    expect(transcriptSource).not.toContain(".message-action-item:focus-visible { outline: 2px solid var(--ring)");
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

  it("shows a centered transient chat toast when the active agent reaches paused", () => {
    expect(workbenchPropBuildersSource).toContain("agentControlState: options.activeAgentControlState()");
    expect(transcriptSource).toContain("agentPauseJustTriggered");
    expect(transcriptSource).toContain("data-agent-pause-toast");
    expect(transcriptSource).toContain("absolute inset-0 z-30 grid place-items-center");
    expect(transcriptSource).toContain(">Agent paused</span>");
    expect(transcriptSource).toContain("PAUSE_TOAST_DURATION_MS = 2_400");
  });

  it("keeps the jump-to-latest arrow nearly transparent over transcript content", () => {
    expect(transcriptSource).toContain("bg-panel-strong/15");
    expect(transcriptSource).toContain("backdrop-blur-sm");
    expect(transcriptSource).toContain("hover:bg-panel-hover/45");
    expect(transcriptSource).not.toContain("bg-panel-strong/70");
  });

  it("keeps project and Git branch between context and usage status chrome", () => {
    const context = runtimeStatusSource.indexOf("data-runtime-context");
    const workspace = runtimeStatusSource.indexOf("data-runtime-workspace");
    const usage = runtimeStatusSource.indexOf('title="Session usage and cost"');
    expect(context).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(context);
    expect(usage).toBeGreaterThan(workspace);
    expect(runtimeStatusSource).toContain("({workspaceBranch})");
    expect(runtimeStatusSource).toContain('class="min-w-0 truncate text-foreground">{workspaceName}</span>');
    expect(runtimeStatusSource).toContain('text-muted-foreground/55">({workspaceBranch})');
    expect(runtimeStatusSource).not.toContain("--runtime-workspace-color");
    expect(runtimeStatusSource).toContain("title={workspacePath ?? workspaceName}");
    expect(runtimeStatusSource).toContain("{#if status || workspaceName || showSkeletons}");
  });

  it("keeps status-bar slots present as skeletons while draft/start/session state resolves", () => {
    expect(statusSource).toContain('data-status-bar-skeleton="model"');
    expect(statusSource).toContain("{showSkeletons}");
    expect(runtimeStatusSource).toContain("data-runtime-context-skeleton");
    expect(runtimeStatusSource).toContain("data-runtime-workspace-skeleton");
    expect(runtimeStatusSource).toContain("data-runtime-workspace-branch-skeleton");
    expect(runtimeStatusSource).toContain("data-runtime-usage-skeleton");
    expect(statusBarViewModelSource).toContain("shouldShowStatusBarSkeletons");
    expect(statusBarViewModelSource).toContain("runtimeStatusAvailable: runtimeStatus !== undefined");
  });

  it("opens recorded session spend from Usage instead of refreshing account quota", () => {
    expect(runtimeStatusSource).toContain('title="Session usage and cost"');
    expect(runtimeStatusSource).toContain('aria-label="Session usage and cost"');
    expect(runtimeStatusSource).toContain("onOpenSessionUsage()");
    expect(runtimeStatusSource).toContain("provider.models as model");
    expect(runtimeStatusSource).toContain("modelDisplayToneClass(modelRefTone");
    expect(runtimeStatusSource).not.toContain("of session");
    expect(runtimeStatusSource).not.toContain("Account quota now");
    expect(runtimeStatusSource).not.toContain('title="Refresh model usage limits"');
    expect(runtimeStatusSource).not.toContain("onclick={onRefreshModelUsage}");
    expect(runtimeStatusSource).toContain("Could not load recorded usage.");
    expect(runtimeStatusSource).toContain(">Retry</button>");
    expect(runtimeStatusSource).not.toContain("Usage has not been loaded yet.");
    expect(statusBarViewModelSource).toContain("refreshActiveSessionUsage");
    expect(statusBarViewModelSource).toContain("sessionUsageAvailable: !!sessionId && runtimeReady");
    expect(statusBarViewModelSource).not.toContain("refreshDraftModelUsage");
  });

  it("keeps workspace identity and selected-model limits visible for UI-only drafts", () => {
    expect(statusBarViewModelSource).toContain("runtimeStatus = options.modelConfig.draftRuntimeStatus");
    expect(statusBarViewModelSource).not.toContain("options.modelConfig.refreshDraftModelUsage()");
    expect(modelDraftConfigSource).toContain("void refreshUsage(modelRef, state.currentThinking, true)");
    expect(modelDraftConfigSource).not.toContain("refreshModelUsage: true");
    expect(modelDraftConfigSource).toContain("}, true);");
  });

  it("shows live DCP savings and a categorized context legend in status chrome", () => {
    expect(runtimeStatusSource).toContain("status?.dcpTokensSaved");
    expect(runtimeStatusSource).toContain("saved ~{formatCompactTokens(status.dcpTokensSaved)}");
    expect(runtimeStatusSource).toContain("Context ${formatCompactTokens(context.tokens)} / ${formatCompactTokens(context.contextWindow)} tokens");
    expect(runtimeStatusSource).not.toContain("Context ${Math.round(context.percent)}%");
    expect(runtimeStatusSource).toContain('aria-label="Context color legend"');
    expect(runtimeStatusSource).toContain("dcpContextMap(status?.context");
    expect(runtimeStatusSource).toContain("w-16");
    expect(runtimeStatusSource).toContain('kind === "retained" || kind === "occupied"');
    expect(sessionInspectorSource).not.toContain("DcpContextPanel");
  });

  it("keeps Session inspector activity sections as independently persistent native accordions", () => {
    for (const source of [sessionSubagentsSource, sessionTodosSource]) {
      expect(source).toContain('<details');
      expect(source).toContain("<summary");
      expect(source).toContain("[&::-webkit-details-marker]:hidden");
      expect(source).not.toContain("bind:open");
      expect(source).not.toContain("open={$derived");
    }

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
  });

  it("keeps Context and Usage scales neutral light gray while percentage text keeps semantic tones", () => {
    expect(runtimeStatusSource).toContain('class={["relative h-1.5 overflow-hidden rounded-sm bg-border"');
    expect(runtimeStatusSource).toContain('class="absolute inset-y-0 left-0 bg-muted-foreground/65"');
    expect(runtimeStatusSource).not.toContain("toneFillClass");
    expect(runtimeStatusSource).toContain('return "text-tool-success";');
    expect(runtimeStatusSource).toContain('return "text-tool-warning";');
    expect(runtimeStatusSource).toContain('return "text-tool-error";');
    expect(runtimeStatusSource).toContain('return "bg-muted-foreground/65";');
    expect(runtimeStatusSource).toContain("contextTrackCellClass(segment.kind)");
    expect(runtimeStatusSource).toContain("contextLegendCellClass(item.kind)");
    expect(runtimeStatusSource).toContain("class={toneTextClass(tone)}>{Math.round(window.remainingPercent)}%");
    expect(runtimeStatusSource).toContain('TriangleAlert class="h-2.5 w-2.5 text-muted-foreground"');
  });

  it("segments weekly quota into seven day slices without inventing per-day usage", () => {
    expect(runtimeStatusSource).toContain("const WEEKLY_DAY_SEGMENTS = 7");
    expect(runtimeStatusSource).toContain("grid grid-cols-7");
    expect(runtimeStatusSource).toContain("aggregate quota, not per-day usage");
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
