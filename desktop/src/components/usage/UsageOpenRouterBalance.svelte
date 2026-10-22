<script lang="ts">
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import type { OpenRouterUsage } from "../../app/openrouter-usage.svelte";
  import ModelProviderIcon from "../ModelProviderIcon.svelte";

  let { usage, stale = false }: { usage: OpenRouterUsage; stale?: boolean } = $props();

  function usd(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const digits = abs > 0 && abs < 1 ? (abs < 0.01 ? 4 : 3) : 2;
    return `${value < 0 ? "−" : ""}$${abs.toFixed(digits)}`;
  }

  const spend = $derived([
    { key: "day", label: "Today", value: usage.usageDaily },
    { key: "week", label: "Week", value: usage.usageWeekly },
    { key: "month", label: "Month", value: usage.usageMonthly },
  ].filter((item) => typeof item.value === "number"));
  const limit = $derived(typeof usage.keyLimit === "number" && typeof usage.keyLimitRemaining === "number"
    ? { total: usage.keyLimit, remaining: usage.keyLimitRemaining, reset: usage.keyLimitReset } : undefined);
  const budget = $derived(usage.effectiveBudget ?? undefined);
</script>

<section class="mb-2 flex min-w-0 flex-col gap-1.5 text-xs" aria-label="OpenRouter balance" data-openrouter-usage>
  <div class="flex min-w-0 items-center gap-1.5 font-medium">
    <ModelProviderIcon provider="openrouter" />
    <span>OpenRouter</span>
    {#if stale}<span class="ml-auto inline-flex items-center gap-1 font-normal text-muted-foreground"><Hourglass class="h-2.5 w-2.5" aria-hidden="true" />Cached</span>{/if}
  </div>
  {#if typeof usage.balance === "number"}
    <div class="flex items-baseline justify-between gap-2 text-sm">
      <span class="font-medium text-foreground">Balance</span>
      <span class={["font-semibold tabular-nums", usage.balance <= 0 ? "text-tool-error" : usage.balance < 5 ? "text-tool-warning" : "text-tool-success"]}>
        {usd(usage.balance)}{#if typeof usage.totalCredits === "number"}<span class="text-xs font-normal text-muted-foreground"> of {usd(usage.totalCredits)}</span>{/if}
      </span>
    </div>
  {/if}
  {#if limit}
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-muted-foreground">Key limit{limit.reset ? ` (${limit.reset})` : ""}</span>
      <span class="tabular-nums">{usd(limit.remaining)} <span class="text-muted-foreground">of {usd(limit.total)}</span></span>
    </div>
  {/if}
  {#if budget}
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-muted-foreground">Budget{budget.resetInterval ? ` (${budget.resetInterval})` : ""}</span>
      <span class="tabular-nums">{usd(budget.remainingUsd)} <span class="text-muted-foreground">of {usd(budget.limitUsd)}</span></span>
    </div>
  {/if}
  {#if spend.length}
    <div class="grid grid-cols-3 gap-2 pt-0.5" aria-label="Key spend">
      {#each spend as item (item.key)}
        <div class="flex min-w-0 flex-col">
          <span class="text-muted-foreground">{item.label}</span>
          <span class="tabular-nums text-foreground">{usd(item.value)}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>
