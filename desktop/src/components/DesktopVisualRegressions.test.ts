import { describe, expect, it } from "vitest";
import commandSource from "../app/desktop-command-controller.svelte.ts?raw";
import statusBarViewModelSource from "../app/desktop-status-bar-view-model.svelte.ts?raw";
import workbenchPropBuildersSource from "../app/desktop-workbench-prop-builders.ts?raw";
import lspOnboardingSource from "../app/lsp-onboarding.svelte.ts?raw";
import modelDraftConfigSource from "../app/model-draft-config.svelte.ts?raw";
import overlaysViewModelSource from "../app/desktop-overlays-view-model.svelte.ts?raw";
import modelConfigActionsSource from "../app/model-config-actions.ts?raw";
import modelPickerStateSource from "../app/model-picker-state.svelte.ts?raw";
import modelThinkingPickerSource from "./ModelThinkingPicker.svelte?raw";
import composerSource from "./PromptComposer.svelte?raw";
import composerActionsSource from "./PromptComposerActionsMenu.svelte?raw";
import diffViewSource from "./DiffView.svelte?raw";
import elicitationSource from "./ElicitationDialog.svelte?raw";
import gitCommitComposerSource from "./GitCommitComposer.svelte?raw";
import idxSource from "./IdxPanel.svelte?raw";
import lspInstallPaneSource from "./LspInstallPane.svelte?raw";
import packageScriptsSource from "./PackageScriptsPanel.svelte?raw";
import runtimeStatusSource from "./RuntimeStatusBarItems.svelte?raw";
import sessionActivityStatusHudSource from "./SessionActivityStatusHud.svelte?raw";
import statusBarPopoverSource from "./StatusBarPopover.svelte?raw";
import settingsSource from "./SettingsPanel.svelte?raw";
import settingsConfigSource from "./settings/SettingsConfigEditor.svelte?raw";
import settingsNavigationSource from "../lib/settings-navigation.ts?raw";
import desktopSettingsEditorSource from "./settings/DesktopSettingsEditor.svelte?raw";
import settingsFrontierModelsSource from "./settings/SettingsFrontierModels.svelte?raw";
import settingsModelListSource from "./settings/SettingsModelList.svelte?raw";
import toolsSuiteSettingsEditorSource from "./settings/ToolsSuiteSettingsEditor.svelte?raw";
import settingsModelRoutingTiersSource from "./settings/SettingsModelRoutingTiers.svelte?raw";
import settingsModelSelectSource from "./settings/SettingsModelSelect.svelte?raw";
import settingsModelVisibilitySource from "./settings/SettingsModelVisibility.svelte?raw";
import settingsModuleVisibilitySource from "./settings/SettingsModuleVisibility.svelte?raw";
import settingsNumberInputSource from "./settings/SettingsNumberInput.svelte?raw";
import settingsSectionNavSource from "./settings/SettingsSectionNav.svelte?raw";
import statusSource from "./StatusBar.svelte?raw";
import markdownSource from "./MarkdownText.svelte?raw";
import previewSource from "./PreviewPane.svelte?raw";
import terminalSessionsPaneSource from "./TerminalSessionsPane.svelte?raw";
import terminalSource from "./TerminalView.svelte?raw";
import workbenchTerminalPaneSource from "./WorkbenchTerminalPane.svelte?raw";
import tauriLibSource from "../../src-tauri/src/lib.rs?raw";
import toolResultSource from "./ToolResult.svelte?raw";
import transcriptActivityGroupSource from "./TranscriptActivityGroup.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("desktop visual regressions", () => {
  it("distinguishes user turns without messenger-style alignment or changing message actions", () => {
    const userStart = transcriptSource.indexOf('{:else if item.role === "user"}');
    const userEnd = transcriptSource.indexOf('{:else if item.role === "system"}', userStart);
    const user = transcriptSource.slice(userStart, userEnd);
    expect(userStart).toBeGreaterThanOrEqual(0);
    expect(user).not.toContain('data-user-message-author');
    expect(user).not.toContain('<UserRound');
    expect(user).not.toContain('>You</div>');
    expect(user).toContain("border-l-[3px] border-chat-user-border bg-chat-user py-3");
    expect(user).not.toContain("ml-auto");
    expect(user).toContain("<AttachmentGrid");
    expect(user).toContain("<MarkdownText");
    expect(user).toContain('aria-label="Message actions"');
    expect(transcriptSource).toContain('if (next?.type === "message" && next.role === "user") return "mb-8";');
    expect(transcriptActivityGroupSource).toContain('data-activity-name={label} class="font-normal text-muted-foreground/45"');
    expect(transcriptSource).not.toContain('"border-t border-border pt-3"');
  });
  it("keeps compact context and quota controls from painting over one another", () => {
    expect(runtimeStatusSource).toContain('class="runtime-status-layout grid min-w-0 items-center gap-3"');
    expect(runtimeStatusSource).not.toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)]");
    expect(runtimeStatusSource).toContain('class="relative min-w-0" data-runtime-context');
    expect(runtimeStatusSource).toContain("overflow-hidden whitespace-nowrap");
    expect(runtimeStatusSource).not.toContain("ml-auto");
    expect(runtimeStatusSource).not.toContain("justify-between gap-1");
    expect(runtimeStatusSource.match(/>ctx<\/span>/g)).toHaveLength(2);
    expect(runtimeStatusSource).not.toContain(">resets {formatResetDuration");
  });
  it("keeps fixed telemetry slots and only reserves inline savings when positive", () => {
    expect(runtimeStatusSource).toContain("grid-template-columns: minmax(0, max-content) minmax(0, max-content)");
    expect(runtimeStatusSource).toContain("flex: 0 1 auto");
    expect(runtimeStatusSource.match(/class="context-status-slots grid/g)).toHaveLength(2);
    expect(runtimeStatusSource.match(/class="usage-status-slots grid/g)).toHaveLength(2);
    expect(runtimeStatusSource).toContain("grid-template-columns: 3ch 4ch 64px 11ch");
    expect(runtimeStatusSource).toContain("grid-template-columns: 3ch 4ch 64px;");
    expect(runtimeStatusSource).toContain("class:with-savings={showSavings}");
    expect(runtimeStatusSource).toContain('{contextTitle(false)}</div>');
    expect(runtimeStatusSource).toContain('~{savedTokensFormatter.format(status.dcpTokensSaved)} tokens</span>');
    expect(runtimeStatusSource).toContain("grid-auto-columns: max-content");
    expect(runtimeStatusSource).toContain("grid-template-columns: 4ch 56px 5ch 10px");
    expect(runtimeStatusSource).toContain("grid-template-columns: 4ch 32px 5ch 10px");
    expect(runtimeStatusSource).toContain("column-gap: 8px");
    expect(runtimeStatusSource).toContain("column-gap: 6px");
    expect(runtimeStatusSource).not.toContain("quotaColumn");
    expect(runtimeStatusSource).not.toContain("/runtime-status:hidden");
    expect(statusSource).toContain("{quotaWaitIndicator}");
    expect(statusSource).not.toContain("data-quota-wait-indicator");
    expect(runtimeStatusSource).toContain("data-quota-wait-indicator");
  });
  it("keeps the composer placeholder on one visual line", () => {
    expect(composerSource).toContain('"Ask Pix anything…"');
    expect(composerSource).toContain("[&::placeholder]:whitespace-nowrap");
    expect(composerSource).toContain("px-0.5 py-1 leading-5");
  });

  it("keeps normal composer input and actions in one horizontal row", () => {
    const rowStart = composerSource.indexOf("data-prompt-composer-row");
    const rowEnd = composerSource.indexOf("{#if !editorMode && !questionMode && (voiceController.interim", rowStart);
    const row = composerSource.slice(rowStart, rowEnd);
    expect(rowStart).toBeGreaterThanOrEqual(0);
    expect(row).toContain("{#if editorMode || questionMode}");
    expect(row).toContain("<textarea");
    expect(row).toContain("<PromptComposerControls");
    expect(composerSource).not.toContain('class="mt-1.5 flex items-center justify-between gap-2"');
  });

  it("offers file attachments in the overflow menu rather than the normal input row", () => {
    expect(composerActionsSource).toContain("<span>Attach files</span>");
    expect(composerActionsSource).toContain("disabled={!canChooseAttachments}");
    expect(composerActionsSource).toContain("onclick={onChooseAttachments}");
    expect(composerSource).toContain('{ label: "Attach files", disabled: !canChooseAttachments }');
    expect(composerSource).toContain("onChooseAttachments={() => void chooseAttachmentsFromMenu()}");
    expect(composerSource).toMatch(/async function chooseAttachmentsFromMenu\(\)[^]*?composerMenuOpen = false;[^]*?if \(!canChooseAttachments\) return;[^]*?composerMenuTrigger\?\.focus\(\);[^]*?await onChooseAttachments\(\);/);
    expect(composerSource).toMatch(/\{#if editorMode \|\| questionMode\}[^]*?<Paperclip[^]*?\{\/if\}\s*<div class="relative min-w-0 flex-1 text-sm">/);
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

  it("colors transcript selection glyphs without painting wrapped-line or side gaps", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const styles = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf-8");

    expect(transcriptSource).toContain('class="transcript-pane h-full min-h-0 overflow-auto"');
    expect(transcriptSource).toContain('class="mx-auto w-full max-w-4xl px-6');
    expect(styles).toMatch(/:is\(\.transcript-pane, \.preview-text-surface, \.preview-editor\)::selection,\s*:is\(\.transcript-pane, \.preview-text-surface\) \*::selection\s*\{\s*background: transparent;\s*color: var\(--primary\);\s*\}/);
    expect(styles).toMatch(/\.transcript-pane :is\(a, a \*, code, code \*\)::selection\s*\{\s*color: var\(--foreground\);\s*\}/);
    expect(styles).not.toContain(".selection-ink");
    expect(styles).not.toMatch(/\.transcript-pane[^{}]*::selection\s*\{[^}]*background:\s*var\(--selection\)/);
  });

  it("colors Preview document and editor selections without painting line gaps or changing find input selection", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const styles = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf-8");

    expect(previewSource.match(/class="preview-text-surface/g)).toHaveLength(2);
    expect(previewSource).toContain('class="preview-editor ');
    expect(styles).toMatch(/:is\(\.transcript-pane, \.preview-text-surface, \.preview-editor\)::selection,\s*:is\(\.transcript-pane, \.preview-text-surface\) \*::selection\s*\{\s*background: transparent;\s*color: var\(--primary\);\s*\}/);
    expect(styles).toMatch(/\.preview-text-surface :is\(a, a \*, \.markdown-text code, \.markdown-text code \*, \.sh__token--keyword, \.sh__token--jsxliterals\)::selection\s*\{\s*color: var\(--foreground\);\s*\}/);
    expect(styles).not.toContain(".preview-file-search::selection");
  });

  it("uses semantic error and success tokens in diff view instead of primary accent", () => {
    expect(diffViewSource).not.toContain("var(--primary)");
    expect(diffViewSource).toContain("var(--tool-error)");
    expect(diffViewSource).toContain("var(--tool-success)");
    expect(diffViewSource).toContain("var(--tool-info)");
  });

  it("keeps tool diagnostics and failure on child rows instead of promoting them to the activity-group summary", () => {
    expect(transcriptActivityGroupSource).toContain("attention={toolAttention}");
    expect(transcriptActivityGroupSource).toContain('<ToolStatusIcon status={tool.status} attention={toolAttention}');
    expect(transcriptActivityGroupSource).not.toContain("toolGroupAttention");
    expect(transcriptActivityGroupSource).not.toContain("settledFailure");
    // The collapsed header carries no status icon, so failure stays on the child call that failed.
    const summaryStart = transcriptActivityGroupSource.indexOf('<summary bind:this={groupSummary}');
    const summaryEnd = transcriptActivityGroupSource.indexOf("</summary>", summaryStart);
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    expect(transcriptActivityGroupSource.slice(summaryStart, summaryEnd)).not.toContain("ToolStatusIcon");
  });

  it("renders a one-line collapsed header: chevron, neutral comma list, elapsed time", () => {
    const summaryStart = transcriptActivityGroupSource.indexOf('<summary bind:this={groupSummary}');
    const summaryEnd = transcriptActivityGroupSource.indexOf("</summary>", summaryStart);
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    const header = transcriptActivityGroupSource.slice(summaryStart, summaryEnd);
    // One grid row — chevron | truncating comma list | duration — with no second row.
    expect(header).toContain("grid-cols-[14px_minmax(0,1fr)_auto]");
    expect(header).not.toContain("row-span-2");
    expect(header).not.toContain("row-start-2");
    // The disclosure chevron is the header's only icon; names and time share the single line.
    expect(header).toContain('class="h-3.5 w-3.5 shrink-0 transition-transform');
    expect(header).toContain('class="min-h-4 min-w-0 truncate text-xs"');
    expect(header).toContain('data-activity-duration class="shrink-0 text-xs text-muted-foreground/45"');
    expect(header).not.toContain("ToolStatusIcon");
    expect(header).not.toContain("Brain");
    // No aggregate status/action text remains in the collapsed chat header.
    expect(transcriptActivityGroupSource).not.toContain("data-activity-action");
    expect(transcriptActivityGroupSource).not.toContain("data-activity-active");
    expect(transcriptActivityGroupSource).not.toContain("data-activity-more");
    expect(transcriptActivityGroupSource).not.toContain("data-activity-settled");
    // All collapsed names share a neutral tone; expanded rows keep their tool tones.
    expect(transcriptActivityGroupSource).toContain("activityGroupPresentationLabels");
    expect(header).toContain('data-activity-name={label} class="font-normal text-muted-foreground/45"');
    expect(header).not.toContain("data-tool-tone");
    expect(header).not.toContain("tool-name");
    expect(header).not.toContain("text-primary");
    expect(header).not.toContain("animate-pulse");
    expect(transcriptActivityGroupSource).toContain('class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}');
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

  it("shows detailed hover/focus Session status only for real hidden activity", () => {
    expect(statusSource).not.toContain('>Session</span>');
    expect(statusSource).not.toContain('aria-label="Open command palette"');
    expect(statusSource).not.toContain('title="Jump to user message"');
    expect(statusSource).not.toContain('import Command from "@lucide/svelte/icons/command"');
    expect(statusSource).not.toContain('import ListChevronsUpDown from "@lucide/svelte/icons/list-chevrons-up-down"');
    expect(statusSource).not.toContain('import Activity from "@lucide/svelte/icons/activity"');
    expect(statusSource).toContain("<SessionActivityStatusHud");
    expect(statusBarViewModelSource).toContain("sessionSubagentSnapshot: options.sessionSubagentSnapshot()");
    expect(statusBarViewModelSource).toContain("sessionTodoSnapshot: options.sessionTodoSnapshot()");
    expect(sessionActivityStatusHudSource).toContain("sessionSubagentIndicators(subagentSnapshot)");
    expect(sessionActivityStatusHudSource).toContain('(indicator.agent.status === "running" || indicator.agent.status === "retrying")');
    expect(sessionActivityStatusHudSource).toContain('"animate-pulse motion-reduce:animate-none"');
    expect(sessionActivityStatusHudSource).toContain("currentSessionTodoTask(todoSnapshot)");
    expect(sessionActivityStatusHudSource).toContain("visibleSessionTodoRows(todoSnapshot)");
    expect(sessionActivityStatusHudSource).toContain('data-session-activity-summary');
    expect(sessionActivityStatusHudSource).toContain('data-session-subagent-tooltip');
    expect(sessionActivityStatusHudSource).toContain('data-session-todo-tooltip');
    expect(sessionActivityStatusHudSource).toContain('data-session-subagent-tooltip-body');
    expect(sessionActivityStatusHudSource).toContain('data-session-todo-tooltip-body');
    expect(sessionActivityStatusHudSource).not.toContain("max-h-[min(40vh,18rem)]");
    expect(sessionActivityStatusHudSource.match(/min-h-0 overflow-y-auto overscroll-contain/g)).toHaveLength(2);
    expect(statusBarPopoverSource).toContain("absolute right-0 bottom-full");
    expect(sessionActivityStatusHudSource).not.toContain("group-hover:block group-focus-within:block");
    expect(sessionActivityStatusHudSource).toContain("formatSessionSubagentElapsed");
    expect(sessionActivityStatusHudSource).toContain("sessionSubagentModelLabel");
    expect(sessionActivityStatusHudSource).toContain("indicator.preview?.subagentType?.trim()");
    for (const source of [sessionActivityStatusHudSource]) {
      expect(source).toContain('?.subagentType?.trim() || "auto"');
      expect(source).toContain('data-session-subagent-header');
      expect(source).toContain('data-session-subagent-role');
      expect(source).toContain('data-session-subagent-name');
      expect(source).toContain('flex-wrap items-center gap-x-1.5 gap-y-1');
      expect(source).toContain('data-session-subagent-header-icon');
      expect(source).toContain('grid h-4 w-4 shrink-0 place-items-center');
      expect(source).toContain('max-w-full shrink-0 break-words rounded-sm bg-muted');
      expect(source).toContain('-ml-1 max-w-full');
      expect(source).toContain('data-session-subagent-footer');
      expect(source).toContain('border-t border-border pt-1.5 text-xs font-semibold text-foreground');
      expect(source).toContain('import ModelProviderIcon from "./ModelProviderIcon.svelte"');
      expect(source).toContain('{#if modelProviderBrand(');
      expect(source).toContain('<ModelProviderIcon provider={');
      expect(source).toContain('formatSessionSubagentElapsed');
    }
    expect(sessionActivityStatusHudSource).not.toContain('{indicator.runName}');
    expect(sessionActivityStatusHudSource).toContain("bind:this={todoTooltipBody}");
    expect(sessionActivityStatusHudSource).toContain("onOpen={scrollTodoTooltipToCurrent}");
    expect(sessionActivityStatusHudSource).toContain('data-session-todo-current={isCurrent ? "true" : undefined}');
    expect(sessionActivityStatusHudSource).toContain("task.activeForm");
    expect(sessionActivityStatusHudSource).toContain("task.description");
    expect(sessionActivityStatusHudSource).toContain("task.blockedBy");
    expect(sessionActivityStatusHudSource).toContain("{summary.completedTodos}/{summary.totalTodos}");
    expect(sessionActivityStatusHudSource).toContain('import Trash2 from "@lucide/svelte/icons/trash-2"');
    expect(sessionActivityStatusHudSource).toContain('aria-label="Clear session plan"');
    expect(sessionActivityStatusHudSource).toContain("disabled={!canClearTodos || clearingTodos || todoRows.length === 0}");
    expect(statusBarViewModelSource).toContain("canClearTodos: options.canClearTodos()");
    expect(statusBarViewModelSource).toContain("options.clearSessionTodos(sessionId)");
    expect(statusSource).not.toContain('disabled={!canOpenSessionActivity}');
    expect(statusSource).not.toContain('title={`Session activity · ${activityLabel}`}');
    expect(statusBarViewModelSource).not.toContain("inspectorPreference");
    expect(statusBarViewModelSource).not.toContain("canNavigateMessages");
    expect(statusBarViewModelSource).not.toContain("commandPaletteShortcut");
    expect(statusBarViewModelSource).not.toContain("onToggleSessionActivity");
  });

  it("shows the current model provider icon in the status bar model control", () => {
    expect(statusSource).toContain('import ModelProviderIcon from "./ModelProviderIcon.svelte"');
    expect(statusSource).toContain("modelProviderBrand(modelThinking.currentModel.provider)");
    expect(statusSource).toContain("<ModelProviderIcon provider={modelThinking.currentModel.provider} />");
  });

  it("keeps ACP status out of chrome and leaves the composer free of a working pulse", () => {
    expect(statusSource).not.toContain("ACP");
    expect(statusSource).not.toContain("connection-activity");
    expect(statusSource).not.toContain("bg-status");
    expect(statusBarViewModelSource).not.toContain("status: connectionStatus");
    expect(workbenchPropBuildersSource).not.toContain("activeWorking");
    expect(composerSource).not.toContain("activeWorking");
    expect(composerSource).not.toContain("composer-working");
    expect(composerSource).not.toContain("border-pulse");
    // Ordinary input focus semantics stay intact without a working border.
    expect(composerSource).toContain("focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/25");
    expect(composerSource).toContain("dragActive || projectPathDragActive ? \"border-ring ring-1 ring-ring/40\" : \"border-input\"");

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

  it("offers missing-LSP pause/install from chat and moves installation into a workbench pane", () => {
    expect(transcriptSource).toContain("data-lsp-onboarding-toast");
    expect(transcriptSource).toContain("No LSP registered for {lspSuggestion.languageLabel}");
    expect(transcriptSource).toContain("Pause & install");
    expect(transcriptSource).toContain("Install LSP");
    expect(workbenchPropBuildersSource).toContain("lspSuggestion: options.lspOnboarding.activeSuggestion()");
    expect(workbenchPropBuildersSource).toContain("pauseAndInstall(sessionId)");
    expect(lspOnboardingSource).toContain('options.agentState(sessionId) === "paused"');
    expect(lspOnboardingSource).toContain('options.setActiveWorkbenchTabId("lsp-install")');
    expect(lspOnboardingSource).toContain('invoke<LspInstallResult>("install_lsp_server"');
    expect(lspInstallPaneSource).toContain("The conversation is paused while Pix installs this trusted language server.");
    expect(lspInstallPaneSource).toContain("Pix will not continue the agent automatically.");
    expect(lspInstallPaneSource).toContain("Continue the agent when you are ready.");
  });

  it("keeps the jump-to-latest arrow fully transparent over transcript content", () => {
    expect(transcriptSource).toContain("place-items-center rounded-md bg-transparent text-foreground transition-colors hover:text-primary");
    expect(transcriptSource).not.toContain("bg-panel-strong/15");
    expect(transcriptSource).not.toContain("backdrop-blur-sm");
    expect(transcriptSource).not.toContain("hover:bg-panel-hover/45");
    expect(transcriptSource).not.toContain("bg-panel-strong/70");
  });

  it("keeps project identity and Git branch out of Desktop status chrome", () => {
    const context = runtimeStatusSource.indexOf("data-runtime-context");
    const usage = runtimeStatusSource.indexOf('aria-label="Session usage and cost"');
    expect(context).toBeGreaterThanOrEqual(0);
    expect(usage).toBeGreaterThan(context);
    expect(runtimeStatusSource).not.toContain("data-runtime-workspace");
    expect(runtimeStatusSource).not.toContain("workspaceName");
    expect(runtimeStatusSource).not.toContain("workspaceBranch");
    expect(runtimeStatusSource).not.toContain("workspacePath");
    expect(runtimeStatusSource).toContain("{#if status || showSkeletons || quotaWaitIndicator}");
  });

  it("keeps session activity independent from removed workspace status identity", () => {
    expect(runtimeStatusSource).not.toContain("data-runtime-workspace-skeleton");
    expect(runtimeStatusSource).not.toContain("data-runtime-workspace-branch-skeleton");
    expect(sessionActivityStatusHudSource).toContain("indicators.slice(0, 6)");
    expect(sessionActivityStatusHudSource).toContain('class="flex shrink-0 items-center gap-0.5"');
  });

  it("keeps the remaining status-bar slots present as skeletons while draft/start/session state resolves", () => {
    expect(statusSource).toContain('data-status-bar-skeleton="model"');
    expect(statusSource).toContain("{showSkeletons}");
    expect(runtimeStatusSource).toContain("data-runtime-context-skeleton");
    expect(runtimeStatusSource).not.toContain("data-runtime-workspace-skeleton");
    expect(runtimeStatusSource).not.toContain("data-runtime-workspace-branch-skeleton");
    expect(runtimeStatusSource).toContain("data-runtime-usage-skeleton");
    expect(statusBarViewModelSource).toContain("shouldShowStatusBarSkeletons");
    expect(statusBarViewModelSource).toContain("runtimeStatusAvailable: runtimeStatus !== undefined");
  });

  it("opens recorded session spend from Usage instead of refreshing account quota", () => {
    expect(runtimeStatusSource).toContain('aria-label="Session usage and cost"');
    expect(runtimeStatusSource).not.toContain('title="Session usage and cost"');
    expect(runtimeStatusSource).toContain('aria-label="Session usage and cost"');
    expect(runtimeStatusSource).toContain("onOpenSessionUsage()");
    expect(runtimeStatusSource).toContain("provider.models as model");
    expect(runtimeStatusSource).toContain("modelProviderBrand(provider.provider)");
    expect(runtimeStatusSource).toContain("<ModelProviderIcon provider={provider.provider} />");
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
    expect(runtimeStatusSource).toContain(">saved {savedTokensFormatter.format(status.dcpTokensSaved)}");
    expect(runtimeStatusSource).toContain("Context ${formatCompactTokens(context.tokens)} / ${formatCompactTokens(context.contextWindow)} tokens");
    expect(runtimeStatusSource).not.toContain("Context ${Math.round(context.percent)}%");
    expect(runtimeStatusSource).toContain('aria-label="Context color legend"');
    expect(runtimeStatusSource).toContain("dcpContextMap(status?.context");
    expect(runtimeStatusSource).toContain("w-16");
    expect(runtimeStatusSource).toContain('kind === "retained" || kind === "occupied"');
  });

  it("opens context and usage details by click with keyboard-safe dismissal", () => {
    for (const panel of ["Context", "Usage"]) {
      expect(runtimeStatusSource).toContain(`onclick={toggle${panel}}`);
    }
    expect(runtimeStatusSource).not.toContain("onpointerenter=");
    expect(runtimeStatusSource).not.toContain("onfocusin=");
    expect(runtimeStatusSource).not.toContain("onpointerleave=");
    expect(runtimeStatusSource).toContain('onfocusout={(event) => leaveDetails(event, "usage")}');
    expect(runtimeStatusSource).toContain("region.contains(event.relatedTarget)");
    // Panels touch their triggers, matching Plan's lower edge without a dead gap.
    expect(runtimeStatusSource.match(/bottom-full/g)).toHaveLength(2);
    expect(runtimeStatusSource).not.toContain("pb-1.5");
    expect(runtimeStatusSource).not.toContain("bottom-[calc(100%+0.375rem)]");
    expect(runtimeStatusSource).toContain('event.key === "Escape"');
    expect(runtimeStatusSource).toContain('onpointerdown={closeOutside}');
    expect(runtimeStatusSource).toContain('{#snippet contextScale()}');
    expect(runtimeStatusSource).toContain('data-context-scale="compact"');
    expect(runtimeStatusSource).toContain('class={["h-full min-w-0", contextCellClass(segment.kind)]}');
    expect(runtimeStatusSource).toContain('style:flex-grow={segment.share}');
    expect(runtimeStatusSource).toContain('{#snippet contextRing()}');
    expect(runtimeStatusSource).toContain('data-context-ring');
    expect(runtimeStatusSource).toContain('{@render contextScale()}');
    expect(runtimeStatusSource.match(/\{@render contextRing\(\)\}/g)).toHaveLength(1);
    expect(runtimeStatusSource.match(/\{@render contextScaleLegend\(\)\}/g)).toHaveLength(1);
    expect(runtimeStatusSource).toContain('id="runtime-context-popover"');
    expect(runtimeStatusSource).toContain('aria-label="Context usage details"');
    expect(runtimeStatusSource).not.toContain("group-hover:block");
    expect(runtimeStatusSource).not.toContain('role="tooltip"');
    expect(runtimeStatusSource).not.toContain("DCP session statistics");
    expect(runtimeStatusSource).not.toContain("onOpenDcpStats");
    expect(runtimeStatusSource).not.toContain("onCompressContext");
    expect(statusBarViewModelSource).not.toContain("refreshActiveDcpStats");
  });

  it("keeps Plan clear in the status popup without a Session pane", () => {
    expect(sessionActivityStatusHudSource).toContain('aria-label="Clear session plan"');
    expect(statusBarViewModelSource).not.toContain("sessionActivityOpen");
    expect(statusSource).not.toContain("onOpenSessionActivity");
  });

  it("uses neutral light-gray normal percentage text while preserving warning/error tones and original tracks", () => {
    expect(runtimeStatusSource).toContain('class={["relative h-1.5 overflow-hidden rounded-sm bg-border"');
    expect(runtimeStatusSource).toContain('class="absolute inset-y-0 left-0 bg-muted-foreground/50"');
    expect(runtimeStatusSource).not.toContain("toneFillClass");
    expect(runtimeStatusSource).toContain('return "text-muted-foreground";');
    expect(runtimeStatusSource).toContain('return "text-tool-warning";');
    expect(runtimeStatusSource).toContain('return "text-tool-error";');
    expect(runtimeStatusSource).toContain("contextCellClass(segment.kind)");
    expect(runtimeStatusSource).toContain("contextCellClass(item.kind)");
    expect(runtimeStatusSource).toContain('class={["truncate text-right", toneTextClass(tone)]}>{Math.round(window.remainingPercent)}%');
    expect(runtimeStatusSource).toContain('TriangleAlert class="h-2.5 w-2.5 text-tool-warning"');
  });

  it("segments weekly quota into seven day slices without inventing per-day usage", () => {
    expect(runtimeStatusSource).toContain("const WEEKLY_DAY_SEGMENTS = 7");
    expect(runtimeStatusSource).toContain("grid grid-cols-7");
    expect(runtimeStatusSource).toContain("aggregate quota, not per-day usage");
  });

  it("shows the single rate-limit window label beside the percentage without hover", () => {
    // The collapsed API-key rate window (RPM/ITPM/OTPM/TPM) keeps a visible
    // label even as the only indicator; OAuth H/W labels stay as they were.
    expect(runtimeStatusSource).toContain("displayModelUsage(status, now)");
    expect(runtimeStatusSource).toContain("limitingRateWindow(modelUsage)");
    expect(runtimeStatusSource).toContain('{#if label === "R"}');
    expect(runtimeStatusSource).toContain('<span class="truncate leading-3 text-muted-foreground">{modelUsageWindowLabel(label, window)}</span>');
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
    expect(settingsConfigSource).toContain('from "./DesktopSettingsEditor.svelte"');
    expect(settingsConfigSource).toContain('from "./ToolsSuiteSettingsEditor.svelte"');
    expect(settingsConfigSource).toContain("Open in editor");
    expect(settingsConfigSource).toContain("onOpenUserConfig(activeKind)");
    expect(settingsSource).not.toContain('aria-label={`${activeKind} advanced JSONC`}');
    expect(settingsSource).not.toContain("min-h-[28rem]");
    expect(settingsSource).not.toContain("settingsSections");
    expect(settingsNumberInputSource).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(settingsNumberInputSource).toContain("[appearance:textfield]");
    expect(settingsSource).not.toContain("resize-y");
  });

  it("uses a searchable continuous settings page with tracked left chapters", () => {
    expect(settingsSectionNavSource).toContain('aria-label="Settings chapters"');
    expect(settingsSectionNavSource).not.toContain("<select");
    expect(settingsSectionNavSource).not.toContain("overflow-x-auto");
    expect(settingsSectionNavSource).toContain("aria-current");
    expect(settingsSource).toContain('aria-label="Search settings"');
    expect(settingsSource).toContain("use:settingsViewport");
    expect(settingsConfigSource).toContain("{#each sections as chapter");
    expect(settingsSource).not.toContain("chooseKind");
  });

  it("uses the live model catalog instead of free-form model text fields", () => {
    expect(settingsConfigSource).toContain("modelThinkingConfigState(configOptions).models");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelSelect");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelList");
    expect(desktopSettingsEditorSource).toContain("<SettingsModelVisibility");
    expect(desktopSettingsEditorSource).not.toContain('placeholder="provider/model"');
    expect(desktopSettingsEditorSource).not.toContain("SettingsStringList");
    expect(desktopSettingsEditorSource).not.toContain('label="Remembered thinking by model"');
    expect(settingsModelSelectSource).toContain("searchSettingsModelOptions");
    expect(settingsModelSelectSource).toContain('role="combobox"');
    expect(settingsModelSelectSource).toContain('allowCustom = false');
    expect(settingsModelSelectSource).toContain('placeholder={allowCustom ? "provider/model or wildcard" : "Filter models…"}');
    expect(settingsModelListSource).toContain("availableToAdd");
    expect(settingsModelListSource).toContain("<SettingsModelSelect");
    expect(settingsModelListSource).not.toContain("<select");
    expect(settingsModelVisibilitySource).toContain("Choose visible models");
    expect(settingsModelVisibilitySource).toContain("searchSettingsModels");
    expect(desktopSettingsEditorSource).toContain('ariaLabel="CI fix model"');
    expect(desktopSettingsEditorSource).toContain('emptyLabel="Default model"');
    expect(desktopSettingsEditorSource).toContain('ariaLabel="Review model"');
    expect(desktopSettingsEditorSource).toContain('ariaLabel="Commit message model"');
  });

  it("edits frontier models with the live catalog in the Sub-agents section", () => {
    expect(settingsNavigationSource).toContain('{ id: "subagents", label: "Sub-agents" }');
    expect(toolsSuiteSettingsEditorSource).toContain('label="Economy mode"');
    expect(toolsSuiteSettingsEditorSource).toContain('label="Frontier models"');
    expect(toolsSuiteSettingsEditorSource).toContain("<SettingsFrontierModels");
    expect(settingsFrontierModelsSource).toContain("<SettingsModelSelect");
    expect(settingsFrontierModelsSource).toContain("frontierOraclePreview");
    expect(settingsFrontierModelsSource).not.toContain("<select");
    expect(settingsFrontierModelsSource).not.toContain("cursor-pointer");
    expect(settingsFrontierModelsSource).not.toContain("rounded-xl");
  });

  it("shows pi-tools-suite module descriptions on hover like bundled agents", () => {
    expect(settingsModuleVisibilitySource).toContain("title={module.description}");
    expect(settingsModuleVisibilitySource).toContain("{module.name}");
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

  it("offers an explicit Desktop file-editor choice including Gram", () => {
    expect(desktopSettingsEditorSource).toContain('label="File editor"');
    expect(desktopSettingsEditorSource).toContain('label: "Choose an editor…"');
    expect(desktopSettingsEditorSource).toContain("EXTERNAL_EDITOR_OPTIONS");
    expect(desktopSettingsEditorSource).toContain('["desktop", "externalEditor"]');
  });

  it("exposes a Desktop switch for native system notifications", () => {
    expect(desktopSettingsEditorSource).toContain('label="System notifications"');
    expect(desktopSettingsEditorSource).toContain('["desktop", "notifications", "enabled"]');
    expect(desktopSettingsEditorSource).toContain("Send native notifications for completed work, questions, and errors");
  });

  it("keeps one full xterm surface shared by package scripts and the workbench terminal", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const { readFileSync } = await import("node:fs");
    const terminalFontSource = readFileSync(new URL("./terminal-font.css", import.meta.url), "utf8");
    expect(terminalSource).toContain("const TERMINAL_SCROLLBACK_LINES = 5_000;");
    expect(terminalSource).toContain(`fontFamily: '"Geist Mono", "Pix Terminal Nerd Glyphs", ui-monospace, monospace'`);
    expect(terminalSource).toContain('import "./terminal-font.css"');
    expect(terminalFontSource).toContain('font-family: "Pix Terminal Nerd Glyphs"');
    expect(terminalFontSource).toContain('url("./fonts/JetBrainsMonoNerdFontMono-Regular.ttf")');
    expect(terminalSource).toContain('refreshAfterTerminalFontLoad(');
    expect(terminalSource).toContain('document.fonts.load(');
    expect(terminalSource).toContain('lifetime.isActive() && terminal === next');
    expect(terminalSource).toContain('      next,');
    expect(terminalSource).toContain("fontWeight: 400");
    expect(terminalSource).toContain("fontWeightBold: 500");
    expect(terminalSource).toContain("fontSize: 10");
    expect(terminalSource).toContain("minimumContrastRatio: 1");
    expect(terminalSource).not.toContain("minimumContrastRatio: 4.5");
    expect(terminalSource).toContain("bg-code font-mono text-foreground");
    expect(terminalSource).not.toContain("font-family:");
    expect(terminalSource).toContain('cursorStyle: "block"');
    expect(terminalSource).toContain('cursorInactiveStyle: "outline"');
    expect(terminalSource).toContain("cursorBlink: true");
    expect(terminalSource).toContain("terminal.options.cursorBlink = true");
    expect(terminalSource).toContain('selectionBackground: value("--selection", foreground)');
    expect(terminalSource).not.toContain("brightRed:");
    expect(terminalSource).not.toContain("brightGreen:");
    expect(terminalSource).not.toContain("brightBlue:");
    expect(terminalSource).not.toContain("data-terminal-caret");
    expect(terminalSource).not.toContain("syncCaret");
    expect(terminalSource).not.toContain("xterm-cursor");
    expect(terminalSource).toContain("bind:this={scrollTrack}");
    expect(terminalSource).toContain("scrollbarVisible");
    expect(terminalSource).toContain("currentTerminal.scrollToLine");
    expect(terminalSource).toContain("scrollbar-width: none");
    expect(terminalSource).toContain(".xterm-scrollable-element > .scrollbar.vertical");
    expect(terminalSource).toContain("visibility: hidden");
    expect(terminalSource).toContain("pointer-events: none");
    expect(tauriLibSource).toContain('command.env("TERM", "xterm-256color")');
    expect(tauriLibSource).toContain('command.env("COLORTERM", "truecolor")');
    expect(tauriLibSource).toContain('command.env("CLICOLOR", "1")');
    expect(tauriLibSource).toContain('command.env_remove("NO_COLOR")');
    expect(tauriLibSource).toContain('command.env_remove("NODE_DISABLE_COLORS")');
    expect(tauriLibSource).toContain('command.env("FORCE_COLOR", "3")');
    expect(tauriLibSource).toContain('command.env("PI_TRUE_COLOR", "1")');
    expect(tauriLibSource).toContain('command.env("PI_HARDWARE_CURSOR", "1")');
    expect(packageScriptsSource).toContain("<TerminalSessionsPane");
    expect(workbenchTerminalPaneSource).toContain("<TerminalSessionsPane");
    expect(terminalSessionsPaneSource).toContain("<TerminalView");
    expect(terminalSessionsPaneSource).toContain('aria-label={ariaLabel}');
    expect(terminalSessionsPaneSource).toContain("grid h-full min-h-0");
    expect(terminalSource).toContain("terminal-host absolute inset-y-0 left-2 right-2");
    expect(tauriLibSource).not.toContain('command.arg("-f")');
    expect(tauriLibSource).not.toContain('command.args(["--noprofile", "--norc"])');
    expect(tauriLibSource).not.toContain('command.env("PROMPT", "pix:%1~ $ ")');
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
      if (name !== "TerminalView.svelte") {
        expect(source, `${name} must not configure runtime font sizes below 12px`).not.toMatch(/fontSize:\s*(?:[0-9]|1[01])(?:\D|$)/);
      }
    }

    expect(idxSource).toContain('className="text-xs leading-[1.55]"');
    expect(sessionActivityStatusHudSource).toContain("text-xs leading-4 text-muted-foreground");
    expect(toolResultSource).toContain("font-size: 12px");
    expect(terminalSource).toContain("fontSize: 10");
    expect(markdownSource).not.toMatch(/font-size:\s+0\.(?:85|88|9|92|94)em;/);
    expect(markdownSource).toContain("max(0.85em, 0.75rem)");
  });
});
