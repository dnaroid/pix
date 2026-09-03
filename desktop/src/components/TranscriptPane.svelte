<script lang="ts">
  import type { TranscriptState } from "../lib/transcript";

  let {
    transcript,
    activeSessionId,
    workspace,
    canCreate,
    promptRunning,
    operationRunning,
    pane = $bindable(null),
    onCreate,
    onChooseWorkspace,
  }: {
    transcript: TranscriptState;
    activeSessionId: string | null;
    workspace: string;
    canCreate: boolean;
    promptRunning: boolean;
    operationRunning: boolean;
    pane?: HTMLDivElement | null;
    onCreate: () => void;
    onChooseWorkspace: () => void;
  } = $props();
</script>

<div class="row-start-2 min-h-0 overflow-auto scroll-smooth" bind:this={pane} aria-live="polite">
  {#if !activeSessionId}
    <section class="grid h-full place-items-center content-center p-10 text-center">
      <div class="mb-[18px] grid h-11 w-11 place-items-center rounded-xl bg-primary font-semibold text-primary-foreground shadow-xs">P</div>
      <h2 class="mb-2 text-lg font-medium text-foreground">
        {workspace ? "Ready for a new task" : "Open a workspace"}
      </h2>
      <p class="mb-5 max-w-[470px] text-[13px] leading-relaxed text-muted-foreground">
        {workspace ? "Start a project-scoped Pix session." : "Choose a folder to begin a Pix session."}
      </p>
      {#if workspace}
        <button
          class="rounded-lg border border-border bg-secondary px-3.5 py-2 text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          onclick={onCreate}
          disabled={!canCreate}
        >+ New conversation</button>
      {:else}
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
      {#each transcript.items as item (item.id)}
        {#if item.type === "message"}
          {#if item.role === "thought"}
            <details class="group mb-5 max-w-[1120px] px-0.5 text-xs text-muted-foreground">
              <summary class="cursor-pointer text-muted-foreground select-none group-open:mb-2">
                <span class="text-[8px] text-primary">●</span> thinking
              </summary>
              <div class="ml-3.5 border-l border-border pl-2.5 leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {item.text}
              </div>
            </details>
          {:else if item.role === "user"}
            <article class="mr-0 mb-6 ml-auto w-fit max-w-[min(780px,86%)] rounded-xl rounded-br-md border border-border bg-card px-3.5 py-2.5 text-card-foreground shadow-xs">
              <div class="leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</div>
            </article>
          {:else}
            <article class="mb-6 max-w-[1120px] text-foreground">
              <div class="mb-1.5 text-[11px] font-semibold text-muted-foreground">Pix</div>
              <div class="leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</div>
            </article>
          {/if}
        {:else}
          <article class={[
            "mb-4 max-w-[1120px] overflow-hidden bg-transparent text-muted-foreground",
            item.status === "failed" && "text-destructive",
          ]}>
            <div class="flex min-h-5 items-center gap-2">
              <span class="text-[8px] text-primary">{item.status === "failed" ? "×" : "●"}</span>
              <span class="text-xs lowercase">{item.kind}</span>
              <strong class="text-xs font-normal text-foreground">{item.title}</strong>
              <span class="ml-auto text-[10px] lowercase text-muted-foreground">{item.status.replace("_", " ")}</span>
            </div>
            {#if item.content}
              <pre class="mt-2 ml-3.5 max-h-[220px] overflow-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">{item.content}</pre>
            {/if}
          </article>
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
