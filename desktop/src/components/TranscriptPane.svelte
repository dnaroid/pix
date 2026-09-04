<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Attachment } from "../lib/attachments";
  import { toolPresentation } from "../lib/tool-presentation";
  import { toolGroupAttention, toolLspAttention } from "../lib/tool-output";
  import { groupTranscriptItems, type TranscriptState } from "../lib/transcript";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolResult from "./ToolResult.svelte";
  import ToolStatusIcon from "./ToolStatusIcon.svelte";

  let {
    transcript,
    activeSessionId,
    workspace,
    promptRunning,
    operationRunning,
    pane = $bindable(null),
    onChooseWorkspace,
    onOpenAttachment,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
  }: {
    transcript: TranscriptState;
    activeSessionId: string | null;
    workspace: string;
    promptRunning: boolean;
    operationRunning: boolean;
    pane?: HTMLDivElement | null;
    onChooseWorkspace: () => void;
    onOpenAttachment: (attachment: Attachment) => void;
    onOpenProjectFile: (path: string) => void | Promise<void>;
    onResolveProjectMedia: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile: (path: string) => void | Promise<void>;
    onResolveLocalMedia: (path: string) => Promise<Attachment | undefined>;
  } = $props();

  let displayItems = $derived(groupTranscriptItems(transcript.items));
</script>

<div class="transcript-pane row-start-2 min-h-0 overflow-auto scroll-smooth" bind:this={pane} aria-live="polite">
  {#if !activeSessionId}
    <section class="grid h-full place-items-center content-center p-10 text-center">
      {#if workspace}
        <p class="text-[13px] text-muted-foreground" role="status">Opening conversation…</p>
      {:else}
        <div class="mb-[18px] grid h-11 w-11 place-items-center rounded-xl bg-primary font-semibold text-primary-foreground shadow-xs">P</div>
        <h2 class="mb-2 text-lg font-medium text-foreground">Open a workspace</h2>
        <p class="mb-5 max-w-[470px] text-[13px] leading-relaxed text-muted-foreground">
          Choose a folder to begin a Pix session.
        </p>
        <button
          class="rounded-lg border border-border bg-secondary px-3.5 py-2 text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          onclick={onChooseWorkspace}
          disabled={promptRunning || operationRunning}
        >Choose workspace</button>
      {/if}
    </section>
  {:else if transcript.items.length === 0}
    <section class="grid min-h-[220px] place-items-center content-center p-10 text-center">
      <h2 class="mb-2 text-lg font-medium text-foreground">What should we work on?</h2>
      <p class="mb-5 max-w-[470px] text-[13px] leading-relaxed text-muted-foreground">
        Pix can inspect this workspace, edit files, and run your development tools.
      </p>
    </section>
  {:else}
    <div class="w-full px-6 pt-[22px] pb-[54px] max-[760px]:px-3">
      {#each displayItems as item (item.id)}
        {#if item.type === "message"}
          {#if item.role === "thought"}
            <details class="group mb-5 w-full min-w-0 text-xs text-muted-foreground">
              <summary class="grid min-h-5 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 text-muted-foreground transition-colors select-none hover:text-foreground group-open:mb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                <Brain class="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                <span>thinking</span>
              </summary>
              <div class="ml-[7px] border-l border-border pl-2.5 text-muted-foreground">
                <MarkdownText text={item.text} compact dense {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
              </div>
            </details>
          {:else if item.role === "user"}
            <div class="mb-6">
              <article class="w-full rounded-xl border border-primary/45 bg-primary/15 px-3.5 pt-3 pb-2 text-card-foreground shadow-xs">
                <AttachmentGrid attachments={item.attachments} onOpen={onOpenAttachment} />
                {#if item.text}<MarkdownText text={item.text} dense {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />{/if}
              </article>
            </div>
          {:else}
            <article class="mb-6 w-full min-w-0 text-foreground">
              <AttachmentGrid attachments={item.attachments} onOpen={onOpenAttachment} />
              {#if item.text}<MarkdownText text={item.text} dense {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />{/if}
            </article>
          {/if}
        {:else}
          {@const groupAttention = toolGroupAttention(item.tools)}
          <details class={[
            "group mb-4 w-full min-w-0 overflow-hidden bg-transparent text-muted-foreground",
            item.status === "failed" && "text-destructive",
          ]} open={item.active && !operationRunning}>
            <summary class="grid min-h-5 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              <ToolStatusIcon status={item.status} attention={groupAttention} />
              <strong class="min-w-0 truncate text-xs font-normal text-foreground">
                {item.tools.length} tool {item.tools.length === 1 ? "call" : "calls"}
              </strong>
            </summary>
            <div class="mt-2 ml-[7px] space-y-1 border-l border-border pl-2.5">
              {#each item.tools as tool (tool.id)}
                {@const presentation = toolPresentation(tool)}
                {@const attention = toolLspAttention(tool)}
                <section>
                  {#if tool.content || tool.diffs.length > 0 || tool.attachments.length > 0}
                    <details class="group/result">
                      <summary class="grid min-h-5 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/result:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                        <ToolStatusIcon status={tool.status} {attention} />
                        <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                          <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                          {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                        </span>
                      </summary>
                      <AttachmentGrid attachments={tool.attachments} variant="tool" onOpen={onOpenAttachment} />
                      {#if tool.content || tool.diffs.length > 0}
                        <ToolResult {tool} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
                      {/if}
                    </details>
                  {:else}
                    <div class="grid min-h-5 grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden">
                      <span aria-hidden="true"></span>
                      <ToolStatusIcon status={tool.status} {attention} />
                      <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                        <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                        {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                      </span>
                    </div>
                  {/if}
                </section>
              {/each}
            </div>
          </details>
        {/if}
      {/each}
      {#if promptRunning}
        <div class="flex gap-1.5 py-1" aria-label="Pix is working">
          <span class="h-[5px] w-[5px] animate-bounce rounded-full bg-primary motion-reduce:animate-none"></span>
          <span class="h-[5px] w-[5px] animate-bounce rounded-full bg-primary [animation-delay:180ms] motion-reduce:animate-none"></span>
          <span class="h-[5px] w-[5px] animate-bounce rounded-full bg-primary [animation-delay:360ms] motion-reduce:animate-none"></span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .transcript-pane {
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 24px,
      black calc(100% - 48px),
      transparent 100%
    );
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 24px,
      black calc(100% - 48px),
      transparent 100%
    );
  }

  .tool-name[data-tool-tone="accent"] { color: var(--tool-accent); }
  .tool-name[data-tool-tone="info"] { color: var(--tool-info); }
  .tool-name[data-tool-tone="muted"] { color: var(--tool-muted); }
  .tool-name[data-tool-tone="mutation"] { color: var(--tool-mutation); }
  .tool-name[data-tool-tone="search"] { color: var(--tool-search); }
  .tool-name[data-tool-tone="success"] { color: var(--tool-success); }
  .tool-name[data-tool-tone="title"] { color: var(--tool-title); }
  .tool-name[data-tool-tone="warning"] { color: var(--tool-warning); }
</style>
