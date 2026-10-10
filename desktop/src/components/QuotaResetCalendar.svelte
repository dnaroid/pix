<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ModelUsageLimitWindow } from "../lib/acp-client";
  import { quotaCycleTimeline } from "../lib/quota-calendar";
  import { clampUsagePercent, formatResetDuration } from "../lib/runtime-status";

  let { window, now }: { window: ModelUsageLimitWindow; now: number } = $props();
  const timeline = $derived(quotaCycleTimeline(window, now));
  const remainingPercent = $derived(clampUsagePercent(window.remainingPercent));
  const usedPercent = $derived(100 - remainingPercent);
  const validReset = $derived(window.resetAt > 0 && Number.isFinite(new Date(window.resetAt).getTime()));
  const resetLabel = $derived(validReset ? new Date(window.resetAt).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "Reset time unavailable");
  const timingLabel = $derived(timeline
    ? `Now: ${Math.round(timeline.timePosition)}% of window time elapsed (start left, reset right)`
    : "Window timing unavailable");
</script>

<div class="mt-1" role="group" aria-label={`Weekly account quota: ${Math.round(usedPercent)}% used, ${Math.round(window.remainingPercent)}% remaining. ${timingLabel}. Reset: ${resetLabel}${validReset ? `, ${formatResetDuration(window.resetAt, now)}` : ""}`} data-quota-calendar>
  <div class="relative h-3.5 w-full" aria-hidden="true">
    <div class="absolute inset-0 overflow-hidden rounded-sm bg-border">
      <div class="absolute inset-y-0 right-0 bg-foreground" style={`width: ${remainingPercent}%`} data-weekly-remaining-fill></div>
      {#if timeline}
        <div class="absolute inset-0 grid grid-cols-7" data-weekly-day-sectors>
          {#each Array.from({ length: 7 }) as _, index}
            <i class={index === 0 ? "" : "border-l border-background/40"} data-day-sector></i>
          {/each}
        </div>
      {/if}
    </div>
    {#if timeline}
      <span class="absolute -top-1 z-10 h-[calc(100%+8px)] w-0" style={`left: clamp(3px, ${timeline.timePosition}%, calc(100% - 3px))`} data-weekly-now-marker>
        <span class="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary ring-1 ring-popover"></span>
        <svg class="absolute -top-1 left-1/2 h-1.5 w-2 -translate-x-1/2 fill-primary" viewBox="0 0 8 6"><path d="M0 0H8L4 6Z" /></svg>
      </span>
    {/if}
  </div>
  {#if timeline}
    <div class="relative mt-2 h-4 text-xs tabular-nums" data-quota-cycle-dates>
      {#each timeline.ticks as tick, index}
        <span
          class={["absolute inline-flex items-center gap-0.5 whitespace-nowrap", index === 0 ? "left-0" : index === 7 ? "right-0" : "-translate-x-1/2"]}
          style:left={index > 0 && index < 7 ? `${tick.position}%` : undefined}
          aria-label={`${tick.fullDate}${index === 7 ? ", quota reset" : ""}`}
        >{tick.label}{#if index === 7}<RefreshCw class="h-2.5 w-2.5" aria-hidden="true" />{/if}</span>
      {/each}
    </div>
  {/if}
  {#if !validReset}
    <div class="mt-1.5 text-muted-foreground">Reset time unavailable</div>
  {:else if window.resetAt <= now}
    <div class="mt-1.5 text-muted-foreground">Reset time reached · Awaiting quota refresh</div>
  {:else if !timeline}
    <div class="mt-1.5 text-muted-foreground">Window timing unavailable · Reset {resetLabel}</div>
  {/if}
</div>
