<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ModelUsageResetCredit } from "../lib/acp-client";
  import { formatResetDuration } from "../lib/runtime-status";

  let { credits, availableCount, now }: {
    credits: readonly ModelUsageResetCredit[];
    availableCount?: number;
    now: number;
  } = $props();

  const available = $derived(credits.filter((credit) => credit.expiresAt === undefined || credit.expiresAt > now));
  function quantity(rows: readonly ModelUsageResetCredit[]): number {
    return rows.reduce((total, credit) => total + (credit.count ?? 1), 0);
  }
  const count = $derived(Math.max(0, (availableCount ?? quantity(credits)) - (quantity(credits) - quantity(available))));
  const visible = $derived.by(() => {
    let remaining = count;
    return available.flatMap((credit) => {
      const size = Math.min(credit.count ?? 1, remaining);
      remaining -= size;
      return size > 0 ? [{ ...credit, ...(credit.count === undefined ? {} : { count: size }) }] : [];
    });
  });
  const missing = $derived(count - quantity(visible));

  function expiryLabel(expiresAt: number | undefined): string {
    if (expiresAt === undefined) return "Expiry unavailable";
    return new Date(expiresAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function countdownLabel(credit: ModelUsageResetCredit): string {
    if (credit.expiresAt === undefined) return "Expiry unavailable";
    const countdown = `Expires in ${formatResetDuration(credit.expiresAt, now)}`;
    if (credit.count === undefined) return countdown;
    const date = new Date(credit.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${date} · ${countdown}`;
  }
</script>

{#if count > 0}
  <section class="mb-3 border-b border-border pb-3" aria-label="Available reset credits" data-reset-credits>
    <div class="flex items-center justify-between gap-2 text-muted-foreground">
      <span>Reset credits</span>
      <span>{count} available</span>
    </div>
    <div class="mt-2 space-y-1">
      {#each visible as credit, index (`${credit.title}:${credit.expiresAt ?? "unknown"}:${index}`)}
        {@const urgent = credit.expiresAt !== undefined && credit.expiresAt - now < 86_400_000}
        <div class="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1">
          <RefreshCw class="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
          <span class={["min-w-0 flex-1 truncate", urgent ? "text-tool-error" : "text-foreground"]}>{credit.title}{(credit.count ?? 1) > 1 ? ` ×${credit.count}` : ""}</span>
          <span class={["shrink-0", urgent ? "text-tool-error" : "text-muted-foreground"]}
            aria-label={expiryLabel(credit.expiresAt)}>{countdownLabel(credit)}</span>
        </div>
      {/each}
    </div>
    {#if missing > 0}
      <div class="mt-2 text-muted-foreground">Expiry details unavailable for {missing} {missing === 1 ? "credit" : "credits"}</div>
    {/if}
  </section>
{/if}
