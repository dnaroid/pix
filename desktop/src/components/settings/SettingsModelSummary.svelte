<script lang="ts" module>
  export type ModelSummaryRow = {
    readonly label: string;
    /** provider/model, optionally with a `:thinking` suffix. */
    readonly ref: string;
    readonly thinking?: string;
    readonly fallbacks?: readonly string[];
    /** Shown when ref is empty. */
    readonly emptyLabel?: string;
  };

  const LEVEL_SUFFIX = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/u;

  export function splitModelRef(ref: string): { ref: string; thinking?: string } {
    const match = LEVEL_SUFFIX.exec(ref);
    return match ? { ref: match[1]!, thinking: match[2]! } : { ref };
  }
</script>

<script lang="ts">
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import { requestModelSetup } from "../../lib/model-setup-request.svelte";

  let { rows, models }: { rows: readonly ModelSummaryRow[]; models: readonly ModelThinkingModel[] } = $props();

  const nameOf = (ref: string) => models.find((model) => model.ref === ref)?.name ?? ref.slice(ref.indexOf("/") + 1);
  const view = $derived(rows.map((row) => {
    const parsed = splitModelRef(row.ref);
    return { ...row, ref: parsed.ref, thinking: row.thinking || parsed.thinking };
  }));
</script>

<div class="rounded-md border border-border bg-panel-strong px-2.5 py-1.5">
  <dl class="grid grid-cols-[minmax(110px,0.8fr)_minmax(0,1.6fr)] gap-x-3 gap-y-1 text-xs">
    {#each view as row (row.label)}
      <dt class="truncate text-muted-foreground">{row.label}</dt>
      <dd class="min-w-0 truncate text-foreground" title={[row.ref, ...(row.fallbacks ?? [])].filter(Boolean).join(" → ")}>
        {#if row.ref}
          {nameOf(row.ref)}{#if row.thinking}<span class="text-muted-foreground">&nbsp;· {row.thinking}</span>{/if}{#if row.fallbacks?.length}<span class="text-muted-foreground">&nbsp;· +{row.fallbacks.length} fallback{row.fallbacks.length === 1 ? "" : "s"}</span>{/if}
        {:else}
          <span class="text-muted-foreground">{row.emptyLabel ?? "Not set"}</span>
        {/if}
      </dd>
    {/each}
  </dl>
</div>
<button
  class="mt-2 inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
  type="button"
  onclick={requestModelSetup}
>Edit in wizard…</button>
