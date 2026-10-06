<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import type { ModelUsageLimitWindow } from "../lib/acp-client";
  import {
    clampUsagePercent,
    formatResetDuration,
    modelUsageTone,
    modelUsageWindowLabel,
    modelUsageWindowWillExhaustBeforeReset,
    type UsageTone,
  } from "../lib/runtime-status";

  let {
    windows,
    now,
    stale = false,
  }: {
    /** Account quota windows only (hourly/weekly); header-derived rate windows do not belong here. */
    windows: readonly { key: string; label: "H" | "W"; window: ModelUsageLimitWindow }[];
    now: number;
    stale?: boolean;
  } = $props();

  function toneTextClass(tone: UsageTone): string {
    if (tone === "error") return "text-tool-error";
    if (tone === "warning") return "text-tool-warning";
    return "text-tool-success";
  }
</script>

{#if windows.length}
  <section class="mb-3 border-b border-border pb-3" aria-label="Account usage limits" data-usage-limit-bars>
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Limits</span>
      {#if stale}<span class="inline-flex items-center gap-1 text-muted-foreground"><Hourglass class="h-2.5 w-2.5" aria-hidden="true" />Cached</span>{/if}
    </div>
    <div class="flex flex-col gap-2">
      {#each windows as { key, label, window } (key)}
        {@const tone = modelUsageTone(window.remainingPercent)}
        {@const exhaustsEarly = modelUsageWindowWillExhaustBeforeReset(window, now)}
        <div class="flex items-center gap-2" aria-label={`${modelUsageWindowLabel(label, window)} ${Math.round(window.remainingPercent)}% remaining, ${formatResetDuration(window.resetAt, now)}`}>
          <span class="w-16 shrink-0 truncate text-muted-foreground">{modelUsageWindowLabel(label, window)}</span>
          <span class="relative h-1.5 flex-1 overflow-hidden rounded-sm bg-border" aria-hidden="true">
            <span
              class="absolute inset-y-0 left-0 bg-muted-foreground/50"
              style={`width: ${clampUsagePercent(window.remainingPercent)}%`}
            ></span>
          </span>
          <span class={["w-9 shrink-0 text-right tabular-nums", toneTextClass(tone)]}>{Math.round(window.remainingPercent)}%</span>
          <span class="w-14 shrink-0 text-right text-muted-foreground">{formatResetDuration(window.resetAt, now)}</span>
          <span class="flex w-2.5 shrink-0 items-center justify-center">
            {#if exhaustsEarly}
              <TriangleAlert class="h-2.5 w-2.5 text-tool-warning" aria-label="Projected to exhaust before reset" />
            {/if}
          </span>
        </div>
      {/each}
    </div>
  </section>
{/if}
