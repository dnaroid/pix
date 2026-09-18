import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import statusBarViewModelSource from "../app/desktop-status-bar-view-model.svelte.ts?raw";
import modelDraftConfigSource from "../app/model-draft-config.svelte.ts?raw";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import modelPickerStateSource from "../app/model-picker-state.svelte.ts?raw";
import composerSource from "./PromptComposer.svelte?raw";
import diffViewSource from "./DiffView.svelte?raw";
import elicitationSource from "./ElicitationDialog.svelte?raw";
import idxSource from "./IdxPanel.svelte?raw";
import packageScriptsSource from "./PackageScriptsPanel.svelte?raw";
import runtimeStatusSource from "./RuntimeStatusBarItems.svelte?raw";
import dcpContextPanelSource from "./DcpContextPanel.svelte?raw";
import sessionSubagentsSource from "./SessionSubagentsPanel.svelte?raw";
import sessionTodosSource from "./SessionTodosPanel.svelte?raw";
import settingsSource from "./SettingsPanel.svelte?raw";
import statusSource from "./StatusBar.svelte?raw";
import markdownSource from "./MarkdownText.svelte?raw";
import terminalSource from "./TerminalView.svelte?raw";
import toolResultSource from "./ToolResult.svelte?raw";

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

  it("suppresses browser-native number and textarea chrome in generated settings", () => {
    expect(settingsSource).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(settingsSource).toContain("[appearance:textfield]");
    expect(settingsSource).not.toContain("resize-y");
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
