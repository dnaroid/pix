<script lang="ts">
  import { OTHER_MODEL, type UsageMetric, type UsageShare } from "../../lib/usage-stats";
  import { formatMetric, modelLabel, seriesColor } from "./usage-format";
  import { activateOnKey } from "./usage-interaction";

  let { shares, metric, estimated = false, label = modelLabel, mono = true, ariaLabel, selected = null, onSelect }: {
    shares: readonly UsageShare[];
    metric: UsageMetric;
    estimated?: boolean;
    label?: (key: string) => string;
    mono?: boolean;
    ariaLabel: string;
    /** Highlighted key; other rows are dimmed. */
    selected?: string | null;
    /** Rows (except the collapsed `Other` tail) toggle selection. */
    onSelect?: (key: string | null) => void;
  } = $props();
</script>

{#snippet row(share: UsageShare, index: number)}
  <div class="flex min-w-0 items-baseline gap-2 text-xs">
    <span class={["min-w-0 flex-1 truncate", mono && "font-mono"]} title={label(share.key)}>{label(share.key)}</span>
    <span class="shrink-0 text-muted-foreground tabular-nums">{formatMetric(share.value, metric, estimated)}</span>
    <span class="w-9 shrink-0 text-right text-muted-foreground tabular-nums">{Math.round(share.share * 100)}%</span>
  </div>
  <div class="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
    <div class="h-full rounded-full" style:width={`${Math.max(1, share.share * 100)}%`} style:background={seriesColor(share.key, index)}></div>
  </div>
{/snippet}

<ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label={ariaLabel}>
  {#each shares as share, index (share.key)}
    <li class={["block w-full min-w-0", selected !== null && selected !== share.key && "opacity-55"]}>
      {#if onSelect && share.key !== OTHER_MODEL}
        <!-- A div with role=button: WebKit button elements shrink-wrap their flex content and collapse the % bars. -->
        <div
          role="button"
          tabindex="0"
          class={["block w-full min-w-0 cursor-pointer rounded-sm px-1 py-0.5 text-left outline-none hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            selected === share.key && "bg-panel-selected"]}
          aria-pressed={selected === share.key}
          title={selected === share.key ? "Clear the filter" : `Filter by ${label(share.key)}`}
          onclick={() => onSelect(selected === share.key ? null : share.key)}
          onkeydown={(event) => activateOnKey(event, () => onSelect(selected === share.key ? null : share.key))}
        ><div class="flex flex-col gap-1">{@render row(share, index)}</div></div>
      {:else}
        <div class="flex w-full min-w-0 flex-col gap-1 px-1 py-0.5">{@render row(share, index)}</div>
      {/if}
    </li>
  {/each}
</ul>
