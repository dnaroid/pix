<script lang="ts">
  import { modelDisplayBgClass, modelDisplayStrokeClass, type ModelDisplayTone } from "../lib/model-display";
  import { formatSessionUsageTokens } from "../lib/session-usage";

  let {
    models,
  }: {
    /** Flattened provider/model token totals; only rendered when more than one entry has tokens. */
    models: readonly { provider: string; model: string; totalTokens: number }[];
  } = $props();

  // Chart categories are models, not providers: neighboring models must not
  // inherit the same provider color. Share the assigned tone with the legend.
  const palette: readonly ModelDisplayTone[] = [
    "model-openai", "model-zai", "model-anthropic", "warning", "info", "accent", "error", "search",
  ];
  const entries = $derived(models.filter((m) => m.totalTokens > 0).map((model, index) => ({
    ...model, tone: palette[index % palette.length],
  })));
  const totalTokens = $derived(entries.reduce((sum, m) => sum + m.totalTokens, 0));
  const RADIUS = 15.915;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  function segments() {
    let offset = 0;
    return entries.map((entry) => {
      const share = totalTokens > 0 ? entry.totalTokens / totalTokens : 0;
      const dash = share * CIRCUMFERENCE;
      const seg = { entry, share, dash, offset };
      offset += dash;
      return seg;
    });
  }
</script>

{#if entries.length > 1}
  <section class="mb-3 border-b border-border pb-3" aria-label="Token usage by model" data-model-usage-donut>
    <div class="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Token usage by model</div>
    <div class="flex items-center gap-3">
      <div class="relative h-16 w-16 shrink-0" aria-hidden="true">
        <svg viewBox="0 0 36 36" class="h-16 w-16 -rotate-90">
          <circle cx="18" cy="18" r={RADIUS} fill="none" class="stroke-border" stroke-width="4"></circle>
          {#each segments() as { entry, dash, offset } (`${entry.provider}/${entry.model}`)}
            <circle
              cx="18" cy="18" r={RADIUS} fill="none"
              class={modelDisplayStrokeClass(entry.tone)}
              stroke-width="4"
              stroke-dasharray={`${dash} ${CIRCUMFERENCE - dash}`}
              stroke-dashoffset={-offset}
            ></circle>
          {/each}
          {#each segments() as { entry, offset } (`${entry.provider}/${entry.model}`)}
            <line
              x1={18 + RADIUS - 2} y1="18"
              x2={18 + RADIUS + 2} y2="18"
              transform={`rotate(${offset / CIRCUMFERENCE * 360} 18 18)`}
              stroke="var(--popover)" stroke-width="0.5"
              data-model-separator
            ></line>
          {/each}
        </svg>
        <div class="absolute inset-0 grid place-items-center">
          <span class="text-xs font-semibold text-foreground">{formatSessionUsageTokens(totalTokens)}</span>
        </div>
      </div>
      <ul class="flex min-w-0 flex-1 flex-col gap-1">
        {#each entries as entry (`${entry.provider}/${entry.model}`)}
          <li class="flex min-w-0 items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1.5">
              <i class={["h-2 w-2 shrink-0 rounded-full", modelDisplayBgClass(entry.tone)]} aria-hidden="true"></i>
              <span class="min-w-0 truncate text-foreground">{entry.model}</span>
            </span>
            <span class="shrink-0 text-muted-foreground tabular-nums">{formatSessionUsageTokens(entry.totalTokens)}</span>
          </li>
        {/each}
      </ul>
    </div>
  </section>
{/if}
