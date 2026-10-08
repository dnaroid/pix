<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import type { ModelUsageLimitWindow } from "../lib/acp-client";
  import {
    clampUsagePercent,
    formatResetDuration,
    modelUsageTone,
    modelUsageWindowLabel,
    modelUsageWindowExceedsDailyBudget,
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

  function weeklyTimePosition(window: ModelUsageLimitWindow): number | null {
    const durationMs = window.windowSeconds * 1000;
    if (!window.hasKnownWindowDuration || !Number.isFinite(durationMs) || durationMs <= 0
      || !Number.isFinite(window.resetAt) || window.resetAt <= 0 || !Number.isFinite(now)) return null;
    // Time remaining, not quota remaining: start on the right, reset on the left.
    return clampUsagePercent((window.resetAt - now) / durationMs * 100);
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
        {@const exceedsDailyBudget = modelUsageWindowExceedsDailyBudget(window, now)}
        {@const timePosition = label === "W" ? weeklyTimePosition(window) : null}
        <div class="flex flex-col gap-1.5" aria-label={`${modelUsageWindowLabel(label, window)} ${Math.round(window.remainingPercent)}% remaining, ${formatResetDuration(window.resetAt, now)}${timePosition === null ? "" : `, Now: ${Math.round(timePosition)}% of window time remaining (start right, reset left)`}`}>
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <span class="font-medium text-foreground">{modelUsageWindowLabel(label, window)}</span>
            <span class={["font-semibold tabular-nums", toneTextClass(tone)]}>{Math.round(window.remainingPercent)}% <span class="text-xs font-normal text-muted-foreground">remaining</span></span>
          </div>
          <span class="relative h-2 w-full" aria-hidden="true">
            <span class="absolute inset-0 overflow-hidden rounded-sm bg-border">
              <span
                class="absolute inset-y-0 left-0 bg-muted-foreground"
                style={`width: ${clampUsagePercent(window.remainingPercent)}%`}
              ></span>
              {#if label === "W"}
                <span class="absolute inset-0 grid grid-cols-7" data-weekly-day-sectors>
                  {#each Array.from({ length: 7 }) as _, index}
                    <i class={index === 0 ? "" : "border-l border-background/80"} data-day-sector></i>
                  {/each}
                </span>
              {/if}
            </span>
            {#if timePosition !== null}
              <span
                class="absolute top-[-3px] h-[calc(100%+6px)] w-px -translate-x-1/2 bg-primary"
                style={`left: clamp(1px, ${timePosition}%, calc(100% - 1px))`}
                data-weekly-now-marker
              >
                <span class="absolute top-[-3px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary"></span>
              </span>
            {/if}
          </span>
          <div class="flex items-center justify-between gap-2">
            <span class="text-foreground tabular-nums">{window.resetAt <= now ? "Reset time reached · Awaiting quota refresh" : `Resets in ${formatResetDuration(window.resetAt, now)}`}</span>
            {#if exceedsDailyBudget}
              <TriangleAlert class="h-3 w-3 shrink-0 text-tool-warning" aria-label="Cumulative daily quota budget exceeded" />
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}
