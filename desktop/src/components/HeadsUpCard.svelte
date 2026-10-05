<script lang="ts">
  import type { HeadsUpNotice, HeadsUpSnapshot } from "../lib/heads-up";
  import type { HeadsUpFeedback } from "../../../src/bundled-extensions/heads-up/contract";

  let {
    notice,
    snapshot,
    notices = [notice],
    pending = false,
    onFeedback,
    onDiscuss,
    onNavigate,
  }: {
    notice: HeadsUpNotice;
    snapshot: HeadsUpSnapshot;
    notices?: readonly HeadsUpNotice[];
    pending?: boolean;
    onFeedback: (feedback: HeadsUpFeedback) => void | Promise<void>;
    onDiscuss: () => void;
    onNavigate?: (direction: -1 | 1) => void;
  } = $props();

  let evidenceOpen = $state(false);
  let position = $derived(Math.max(0, notices.findIndex((item) => item.id === notice.id)) + 1);
</script>

<aside class="mb-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-card-foreground" aria-label="Heads up observer note">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <p class="font-medium text-foreground">{notice.title}</p>
      <p class="mt-0.5 text-muted-foreground">{notice.consequence}</p>
    </div>
    <span class="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground" title={snapshot.model}>{snapshot.model || snapshot.phase}</span>
  </div>

  {#if notices.length > 1}
    <div class="mt-1 flex items-center justify-end gap-1" aria-label="Observer notice navigation">
      <button type="button" aria-label="Previous observer notice" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onclick={() => onNavigate?.(-1)}>Previous</button>
      <span class="min-w-10 text-center text-xs text-muted-foreground" aria-live="polite">{position} / {notices.length}</span>
      <button type="button" aria-label="Next observer notice" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onclick={() => onNavigate?.(1)}>Next</button>
    </div>
  {/if}

  {#if evidenceOpen}
    <div class="mt-2 max-h-48 overflow-auto border-t border-border pt-2" data-heads-up-evidence>
      <ul class="space-y-1 text-muted-foreground">
        {#each notice.evidence as entry (entry.id)}
          <li class="whitespace-pre-wrap break-words"><span class="font-mono text-foreground">[{entry.id}]</span> {entry.text}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-1.5">
    <button type="button" aria-expanded={evidenceOpen} class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onclick={() => evidenceOpen = !evidenceOpen}>
      {evidenceOpen ? "Hide details" : "Show evidence"}
    </button>
    <button type="button" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={() => void onFeedback("known")}>Already know</button>
    <button type="button" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={() => void onFeedback("useful")}>Useful</button>
    <button type="button" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={() => void onFeedback("irrelevant")}>Not useful</button>
    <button type="button" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={() => void onFeedback("incorrect")}>Incorrect</button>
    <button type="button" class="rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={() => void onFeedback("dismiss")}>Dismiss</button>
    <button type="button" class="ml-auto rounded-sm bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" disabled={pending} onclick={onDiscuss}>Discuss / Insert question</button>
  </div>
</aside>
