<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ModelUsageLimitWindow } from "../lib/acp-client";
  import { quotaCalendarDays } from "../lib/quota-calendar";

  let { window, now, stale = false }: {
    window: ModelUsageLimitWindow;
    now: number;
    stale?: boolean;
  } = $props();
  const days = $derived(quotaCalendarDays(window.resetAt, now));
  const resetDate = $derived(new Date(window.resetAt));
  const resetLabel = $derived(days.length ? resetDate.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "Reset time unavailable");
</script>

<section class="mb-3 border-b border-border pb-3" aria-label="Weekly account quota" data-quota-calendar>
  {#if stale}<div class="mb-1 text-tool-warning">Cached</div>{/if}
  {#if days.length}
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium">{new Date(now).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
      <span class="text-muted-foreground">Weekly reset</span>
    </div>
    <div class="mt-1.5 grid gap-1" style:grid-template-columns={`repeat(${days.length}, minmax(0, 1fr))`} aria-label="Today’s week and reset date">
      {#each days as day (day.key)}
        <div class="min-w-0 text-center">
          <div class={["truncate text-xs", day.weekend ? "text-tool-error" : "text-muted-foreground"]}>{day.weekday}</div>
          <span
            class={["mt-0.5 flex h-7 items-center justify-center rounded-sm border font-mono text-sm tabular-nums", day.reset ? "border-primary bg-primary font-semibold text-primary-foreground" : day.today ? "border-muted-foreground/60 bg-muted/40 text-foreground" : day.weekend ? "border-transparent text-tool-error" : "border-transparent text-foreground"]}
            aria-label={`${day.fullDate}${day.reset ? ", quota reset" : ""}${day.today ? ", today" : ""}`}
            aria-current={day.today ? "date" : undefined}
          >{day.day}</span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="mt-2 flex items-start gap-2 text-sm text-foreground" data-quota-reset-detail>
    <RefreshCw class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
    <div>
      <div class="font-medium tabular-nums">{resetLabel}</div>
      {#if days.length && window.resetAt <= now}
        <div class="mt-0.5 text-muted-foreground">
          Reset time reached · Awaiting quota refresh
        </div>
      {/if}
    </div>
  </div>
</section>
