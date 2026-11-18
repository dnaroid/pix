<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ModelUsageLimitWindow } from "../lib/acp-client";
  import { quotaCycleTimeline } from "../lib/quota-calendar";
  import { clampUsagePercent, formatResetDuration } from "../lib/runtime-status";

  let { window, now, deadlines = [] }: { window: ModelUsageLimitWindow; now: number; deadlines?: readonly number[] } = $props();
  const timeline = $derived(quotaCycleTimeline(window, now));
  const remainingPercent = $derived(clampUsagePercent(window.remainingPercent));
  const days = $derived(timeline?.days ?? []);
  const elapsed = $derived((timeline?.timePosition ?? 0) / 100);
  const todayIndex = $derived(Math.max(0, days.findIndex(d => elapsed < d.endFraction) === -1 ? days.length - 1 : days.findIndex(d => elapsed < d.endFraction)));
  const columns = $derived(days.length
    ? days.map(d => `minmax(0, ${Math.max(d.endFraction - d.startFraction, 0.001)}fr)`).join(" ")
    : "minmax(0, 1fr)");
  /** Reset-credit expiries inside the visible window, placed on the same time axis as the pin. */
  const deadlineMarks = $derived.by(() => {
    if (!timeline) return [];
    const start = window.resetAt - window.windowSeconds * 1000;
    const marks: { left: string; label: string }[] = [];
    for (const at of [...new Set(deadlines)]) {
      const f = (at - start) / (window.windowSeconds * 1000);
      if (!(f >= 0 && f <= 1)) continue;
      marks.push({
        left: `${f * 100}%`,
        label: new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      });
    }
    return marks;
  });
  const usedPercent = $derived(100 - remainingPercent);
  const validReset = $derived(window.resetAt > 0 && Number.isFinite(new Date(window.resetAt).getTime()));
  const resetLabel = $derived(validReset ? new Date(window.resetAt).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "Reset time unavailable");
  const resetShort = $derived(validReset ? new Date(window.resetAt).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "");
  const timingLabel = $derived(timeline
    ? `Now: ${Math.round(timeline.timePosition)}% of window time elapsed (start left, reset right)`
    : "Window timing unavailable");
</script>

<div class="mt-1" role="group" aria-label={`Weekly account quota: ${Math.round(usedPercent)}% used, ${Math.round(window.remainingPercent)}% remaining. ${timingLabel}.${deadlineMarks.length ? ` Reset credits expire: ${deadlineMarks.map(m => m.label).join("; ")}.` : ""} Reset: ${resetLabel}${validReset ? `, ${formatResetDuration(window.resetAt, now)}` : ""}`} data-quota-calendar>
  <div class="relative h-3.5 w-full" aria-hidden="true">
    <div class="relative h-full overflow-hidden rounded-sm bg-border" data-weekly-progress-track>
      <span class="absolute inset-y-0 right-0 bg-foreground" style={`width: ${remainingPercent}%`} data-weekly-remaining-fill></span>
      {#each days.slice(0, -1) as day}
        <span class="absolute inset-y-0 w-px bg-popover/80" style={`left: ${day.endFraction * 100}%`} data-weekly-day-divider></span>
      {/each}
    </div>
    {#each deadlineMarks as mark}
      <span class="absolute -bottom-1 -top-0.5 z-[5] w-0.5 -translate-x-1/2 rounded-full bg-tool-error ring-1 ring-popover" style:left={`clamp(1px, ${mark.left}, calc(100% - 1px))`} data-reset-credit-deadline></span>
    {/each}
    {#if timeline}
      <span class="absolute -top-1 z-10 h-[calc(100%+8px)] w-0" style={`left: clamp(3px, ${timeline.timePosition}%, calc(100% - 3px))`} data-weekly-now-marker>
        <span class="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary ring-1 ring-popover"></span>
        <svg class="absolute -top-1 left-1/2 h-1.5 w-2 -translate-x-1/2 fill-primary" viewBox="0 0 8 6"><path d="M0 0H8L4 6Z" /></svg>
      </span>
    {/if}
  </div>
  {#if timeline}
    <div class="mt-2 grid text-center tabular-nums" style:grid-template-columns={columns} data-quota-cycle-dates>
      {#each timeline.days as day, index}
        <span
          class={["flex min-w-0 flex-col items-center leading-tight", index === todayIndex ? "text-foreground" : "opacity-60", day.weekend ? "text-tool-warning" : index === todayIndex ? "" : "text-muted-foreground"]}
          data-weekend={day.weekend ? "true" : undefined}
          aria-label={`${day.fullDate}${index === days.length - 1 ? ", quota resets at the end of this day" : ""}`}
          data-quota-day={index === todayIndex ? "today" : undefined}
        >
          <span class="text-xs uppercase tracking-wide">{day.weekday}</span>
          <span class={["inline-block min-w-[2ch]", index === todayIndex ? "text-base" : "text-xs"]}>{day.day}</span>
        </span>
      {/each}
    </div>
  {/if}
  {#if validReset && window.resetAt > now && timeline}
    <div class="mt-2 flex items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground" data-quota-reset-time>
      <span class="inline-flex items-center gap-1"><RefreshCw class="h-3 w-3" aria-hidden="true" />Reset {resetShort}</span>
      <span>{formatResetDuration(window.resetAt, now)}</span>
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
