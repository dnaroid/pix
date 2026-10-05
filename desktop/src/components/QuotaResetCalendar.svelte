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
      <span class="text-muted-foreground">Next reset</span>
    </div>
    <div class="mt-2 grid gap-1" style:grid-template-columns={`repeat(${days.length}, minmax(0, 1fr))`} aria-label="Today’s week and reset date">
      {#each days as day (day.key)}
        <div class="min-w-0 text-center">
          <div class={["truncate text-xs", day.weekend ? "text-tool-error" : "text-muted-foreground"]}>{day.weekday}</div>
          <span
            class={["mt-1 flex h-8 items-center justify-center rounded-md border font-mono tabular-nums", day.reset ? "border-primary bg-primary/10" : day.today ? "border-muted-foreground bg-muted" : "border-transparent", day.weekend ? "text-tool-error" : day.reset ? "text-primary" : day.today ? "text-foreground" : "text-muted-foreground"]}
            aria-label={`${day.fullDate}${day.reset ? ", quota reset" : ""}${day.today ? ", today" : ""}`}
            aria-current={day.today ? "date" : undefined}
          >{day.day}</span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="mt-2 flex items-start gap-2 rounded-md bg-muted px-2.5 py-2">
    <RefreshCw class="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
    <div>
      <div class="font-medium">{resetLabel}</div>
      {#if days.length && window.resetAt <= now}
        <div class="mt-0.5 text-muted-foreground">
          Reset time reached · Awaiting quota refresh
        </div>
      {/if}
    </div>
  </div>
</section>
