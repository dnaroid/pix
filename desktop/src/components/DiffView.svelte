<script lang="ts">
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import type { DiffLine, DiffViewModel } from "../lib/diff";

  let {
    model,
    label,
  }: {
    model: DiffViewModel;
    label?: string;
  } = $props();

  function rowClass(line: DiffLine): string {
    if (line.kind === "added") return "diff-row added";
    if (line.kind === "removed") return "diff-row removed";
    if (line.kind === "hunk") return "diff-row hunk";
    if (line.kind === "meta") return "diff-row meta";
    return "diff-row";
  }
</script>

<section class="mt-2 overflow-hidden rounded-lg border border-border bg-muted" aria-label={label ?? model.path ?? "Diff"}>
  {#if label || model.path}
    <header class="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 font-mono text-[11px]">
      <FileDiff class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <strong class="min-w-0 flex-1 truncate font-medium text-foreground">{model.path ?? label}</strong>
      <span class="shrink-0 text-status">+{model.additions}</span>
      <span class="diff-deletions shrink-0">−{model.deletions}</span>
    </header>
  {/if}

  <!-- Scrollable code surfaces need focus so keyboard users can pan them. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="max-h-[300px] overflow-auto"
    role="region"
    aria-label={`${label ?? model.path ?? "Diff"} contents`}
    tabindex="0"
  >
    <div class="min-w-max font-mono text-[11px] leading-[1.55]" role="table">
      {#each model.lines as line}
        <div class={rowClass(line)} role="row">
          <span class="line-number" aria-hidden="true">{line.oldLine ?? ""}</span>
          <span class="line-number" aria-hidden="true">{line.newLine ?? ""}</span>
          <span class="line-content" role="cell">{line.text || " "}</span>
        </div>
      {:else}
        <div class="px-3 py-2 text-muted-foreground">No textual changes</div>
      {/each}
    </div>
  </div>
</section>

<style>
  .diff-row {
    display: grid;
    grid-template-columns: 3rem 3rem minmax(max-content, 1fr);
    min-height: 1.55em;
    color: var(--foreground);
  }

  .diff-row.added {
    background: color-mix(in srgb, var(--status) 13%, transparent);
    color: color-mix(in srgb, var(--status) 82%, var(--foreground));
  }

  .diff-row.removed {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: color-mix(in srgb, var(--primary) 78%, var(--foreground));
  }

  .diff-row.hunk {
    background: color-mix(in srgb, var(--primary) 8%, transparent);
    color: var(--primary);
  }

  .diff-row.meta {
    color: var(--muted-foreground);
    font-weight: 500;
  }

  .line-number {
    border-right: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0 0.55rem;
    color: var(--muted-foreground);
    text-align: right;
    user-select: none;
  }

  .line-content {
    min-width: 100%;
    padding: 0 0.75rem;
    white-space: pre;
  }

  .diff-deletions {
    color: color-mix(in srgb, var(--primary) 78%, var(--foreground));
  }
</style>
