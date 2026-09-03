<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { groupTranscriptItems, type TranscriptState } from "../lib/transcript";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolStatusIcon from "./ToolStatusIcon.svelte";

  let {
    transcript,
    activeSessionId,
    workspace,
    promptRunning,
    operationRunning,
    pane = $bindable(null),
    onChooseWorkspace,
  }: {
    transcript: TranscriptState;
    activeSessionId: string | null;
    workspace: string;
    promptRunning: boolean;
    operationRunning: boolean;
    pane?: HTMLDivElement | null;
    onChooseWorkspace: () => void;
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
            <details class="group mb-5 max-w-[1120px] px-0.5 text-xs text-muted-foreground">
              <summary class="cursor-pointer text-muted-foreground select-none group-open:mb-2">
                <Brain class="mr-1 inline-block h-3 w-3 text-primary" aria-hidden="true" />thinking
              </summary>
              <div class="ml-3.5 border-l border-border pl-2.5 text-muted-foreground">
                <MarkdownText text={item.text} compact />
              </div>
            </details>
          {:else if item.role === "user"}
            <article class="mr-0 mb-6 ml-auto w-fit max-w-[min(780px,86%)] rounded-xl rounded-br-md border border-border bg-card px-3.5 py-2.5 text-card-foreground shadow-xs">
              <MarkdownText text={item.text} />
            </article>
          {:else}
            <article class="mb-6 max-w-[1120px] text-foreground">
              <div class="mb-1.5 text-[11px] font-semibold text-muted-foreground">Pix</div>
              <MarkdownText text={item.text} />
            </article>
          {/if}
        {:else}
          <details class={[
            "group mb-4 max-w-[1120px] overflow-hidden bg-transparent text-muted-foreground",
            item.status === "failed" && "text-destructive",
          ]} open={item.active && !operationRunning}>
            <summary class="flex min-h-5 cursor-pointer list-none items-center gap-2 overflow-hidden select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              <ToolStatusIcon status={item.status} />
              <strong class="min-w-0 truncate text-xs font-normal text-foreground">
                {item.tools.length} tool {item.tools.length === 1 ? "call" : "calls"}
              </strong>
              <span class="ml-auto shrink-0 text-[10px] lowercase text-muted-foreground">{item.status.replace("_", " ")}</span>
            </summary>
            <div class="mt-2 ml-3.5 space-y-3 border-l border-border pl-3">
              {#each item.tools as tool (tool.id)}
                <section>
                  <div class="flex min-h-5 items-center gap-2 overflow-hidden">
                    <ToolStatusIcon status={tool.status} />
                    {#if tool.kind !== "other"}
                      <span class="shrink-0 text-xs lowercase">{tool.kind}</span>
                    {/if}
                    <strong class="min-w-0 truncate text-xs font-normal text-foreground">{tool.title}</strong>
                    <span class="ml-auto shrink-0 text-[10px] lowercase text-muted-foreground">{tool.status.replace("_", " ")}</span>
                  </div>
                  {#if tool.content}
                    <pre class="mt-2 max-h-[220px] overflow-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">{tool.content}</pre>
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
</style>
