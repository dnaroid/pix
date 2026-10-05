<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { observeTranscriptScrollbarGutter } from "../lib/transcript-scrollbar-gutter";
  import ErrorBanner from "./ErrorBanner.svelte";
  import GitDiffPane from "./GitDiffPane.svelte";
  import LspInstallPane from "./LspInstallPane.svelte";
  import PreviewPane from "./PreviewPane.svelte";
  import PromptComposer from "./PromptComposer.svelte";
  import QueuedMessagesPanel from "./QueuedMessagesPanel.svelte";
  import SessionStartView from "./SessionStartView.svelte";
  import TranscriptPane from "./TranscriptPane.svelte";
  import WorkbenchTerminalPane from "./WorkbenchTerminalPane.svelte";

  export type PromptComposerHandle = {
    focus: () => Promise<void>;
    insertPaths: (paths: readonly string[]) => Promise<void>;
  };

  export type PreviewPaneHandle = {
    requestClose: () => boolean;
  };

  export type WorkbenchTerminalPaneHandle = {
    openTerminal: (command: string) => Promise<void>;
  };

  let {
    conversationVisible,
    conversationLabelledBy,
    errorBanner,
    sessionStart,
    transcript,
    queue,
    composer,
    managedCouncil,
    preview,
    previewVisible,
    gitDiff,
    gitDiffVisible,
    lspInstall,
    lspInstallVisible,
    terminal,
    terminalVisible,
    transcriptPane = $bindable(null),
    transcriptContent = $bindable(null),
    promptComposer = $bindable(null),
    promptText = $bindable(""),
    previewPane = $bindable(null),
    terminalPane = $bindable(null),
  }: {
    conversationVisible: boolean;
    conversationLabelledBy?: string;
    errorBanner: ComponentProps<typeof ErrorBanner> | null;
    sessionStart: ComponentProps<typeof SessionStartView> | null;
    transcript: Omit<ComponentProps<typeof TranscriptPane>, "pane" | "content">;
    queue: ComponentProps<typeof QueuedMessagesPanel>;
    composer: Omit<ComponentProps<typeof PromptComposer>, "promptText">;
    managedCouncil?: { runId: string; slot: number; owned: boolean; onOpenParent: () => void };
    preview: ComponentProps<typeof PreviewPane> | null;
    previewVisible: boolean;
    gitDiff: ComponentProps<typeof GitDiffPane> | null;
    gitDiffVisible: boolean;
    lspInstall: ComponentProps<typeof LspInstallPane> | null;
    lspInstallVisible: boolean;
    terminal: ComponentProps<typeof WorkbenchTerminalPane> | null;
    terminalVisible: boolean;
    transcriptPane?: HTMLDivElement | null;
    transcriptContent?: HTMLDivElement | null;
    promptComposer?: PromptComposerHandle | null;
    promptText?: string;
    previewPane?: PreviewPaneHandle | null;
    terminalPane?: WorkbenchTerminalPaneHandle | null;
  } = $props();

  let transcriptScrollbarGutter = $state(0);
  $effect(() => {
    const pane = sessionStart ? null : transcriptPane;
    transcriptScrollbarGutter = 0;
    if (!pane) return;
    return observeTranscriptScrollbarGutter(pane, (width) => {
      transcriptScrollbarGutter = width;
    });
  });
</script>

<div class="relative flex min-h-0 min-w-0 flex-1">
  <div class="relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-background">
    <div
      id="conversation-workspace"
      class={[
        "col-start-1 row-start-1 min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-background",
        conversationVisible ? "grid" : "hidden",
      ]}
      role="tabpanel"
      aria-labelledby={conversationLabelledBy}
    >
      {#if errorBanner}
        <ErrorBanner {...errorBanner} />
      {/if}

      {#if sessionStart}
        <div class="row-start-2 min-h-0 min-w-0">
          <SessionStartView {...sessionStart} />
        </div>
      {:else}
        <TranscriptPane bind:pane={transcriptPane} bind:content={transcriptContent} {...transcript} />
      {/if}

      <div class="row-start-3 min-w-0" style:padding-right={`${transcriptScrollbarGutter}px`}>
        {#if managedCouncil}
          <div class="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground" role="status">
            <span>Brainstorm {managedCouncil.runId} · P{managedCouncil.slot}{managedCouncil.owned ? " · Managed by orchestrator — read only" : " · Finished"}</span>
            <button class="shrink-0 rounded px-2 py-1 text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring" onclick={managedCouncil.onOpenParent}>Open orchestrator</button>
          </div>
        {/if}
        {#if !managedCouncil?.owned}
        <PromptComposer bind:this={promptComposer} bind:promptText {...composer}>
          {#snippet queuedMessages()}
            <QueuedMessagesPanel {...queue} />
          {/snippet}
        </PromptComposer>
        {/if}
      </div>
    </div>

    {#if preview}
      <div
        id="workbench-panel-preview"
        class={previewVisible ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
        role="tabpanel"
        aria-labelledby="workbench-tab-preview"
      >
        <PreviewPane bind:this={previewPane} {...preview} />
      </div>
    {/if}

    {#if gitDiff}
      <div
        id="workbench-panel-git-diff"
        class={gitDiffVisible ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
        role="tabpanel"
        aria-labelledby="workbench-tab-git-diff"
      >
        <GitDiffPane {...gitDiff} />
      </div>
    {/if}

    {#if lspInstall}
      <div
        id="workbench-panel-lsp-install"
        class={lspInstallVisible ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
        role="tabpanel"
        aria-labelledby="workbench-tab-lsp-install"
      >
        <LspInstallPane {...lspInstall} />
      </div>
    {/if}

    {#if terminal}
      <div
        id="workbench-panel-terminal"
        class={terminalVisible ? "col-start-1 row-start-1 flex min-h-0 min-w-0" : "hidden"}
        role="tabpanel"
        aria-labelledby="workbench-tab-terminal"
      >
        <WorkbenchTerminalPane bind:this={terminalPane} {...terminal} />
      </div>
    {/if}
  </div>
</div>
