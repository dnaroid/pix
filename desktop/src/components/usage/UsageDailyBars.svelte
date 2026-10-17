<script lang="ts">
  import { OTHER_MODEL, type UsageDailySeries, type UsageMetric } from "../../lib/usage-stats";
  import UsageTooltip from "./UsageTooltip.svelte";
  import { activateOnKey, anchorOf, type UsageTooltipAnchor } from "./usage-interaction";
  import { formatDayKey, formatMetric, modelLabel, seriesColor } from "./usage-format";

  let { series, metric, estimated = false, selectedDay = null, selectedModel = null, onSelectDay, onSelectModel }: {
    series: UsageDailySeries;
    metric: UsageMetric;
    estimated?: boolean;
    selectedDay?: string | null;
    selectedModel?: string | null;
    onSelectDay?: (day: string | null) => void;
    onSelectModel?: (model: string | null) => void;
  } = $props();

  const HEIGHT = 80;
  const SLOT = 10;
  const BAR = 8;
  const width = $derived(Math.max(1, series.days.length) * SLOT);

  const totals = $derived(series.values.map((row) => row.reduce((sum, value) => sum + value, 0)));
  const peakIndex = $derived(totals.reduce((best, value, index) => value > (totals[best] ?? 0) ? index : best, 0));
  const summary = $derived(series.days.length > 0 && series.max > 0
    ? `Daily ${metric} from ${formatDayKey(series.days[0]!)} to ${formatDayKey(series.days[series.days.length - 1]!)}; peak ${formatMetric(totals[peakIndex] ?? 0, metric, estimated)} on ${formatDayKey(series.days[peakIndex]!)}.`
    : "No daily usage in this period.");

  let hovered = $state<{ index: number; anchor: UsageTooltipAnchor } | null>(null);
  $effect(() => { void series; hovered = null; });

  function segments(row: readonly number[]): { y: number; h: number; color: string; key: string }[] {
    const out: { y: number; h: number; color: string; key: string }[] = [];
    let top = HEIGHT;
    row.forEach((value, index) => {
      if (value <= 0 || series.max <= 0) return;
      const h = Math.max(0.5, (value / series.max) * HEIGHT);
      top -= h;
      const key = series.models[index] ?? "";
      out.push({ y: top, h, color: seriesColor(key, index), key });
    });
    return out;
  }

  function interactive(index: number): boolean {
    return onSelectDay !== undefined && ((totals[index] ?? 0) > 0 || series.days[index] === selectedDay);
  }

  function toggleDay(index: number): void {
    const day = series.days[index];
    if (day === undefined || !interactive(index)) return;
    onSelectDay?.(day === selectedDay ? null : day);
  }

  function selectableModel(model: string): boolean {
    return onSelectModel !== undefined && model !== OTHER_MODEL;
  }

  function show(event: Event, index: number): void {
    hovered = { index, anchor: anchorOf(event.currentTarget as Element) };
  }

  const hoveredRows = $derived.by(() => {
    if (!hovered) return [];
    const row = series.values[hovered.index] ?? [];
    return row.map((value, index) => ({ value, key: series.models[index] ?? "", color: seriesColor(series.models[index] ?? "", index) }))
      .filter((entry) => entry.value > 0)
      .reverse();
  });
</script>

<figure class="m-0 flex flex-col gap-1.5">
  <svg class="block h-20 w-full" viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" role="group" aria-label={summary}>
    <line x1="0" x2={width} y1={HEIGHT - 0.25} y2={HEIGHT - 0.25} stroke="var(--border)" stroke-width="0.5" vector-effect="non-scaling-stroke" />
    {#each series.values as row, dayIndex (series.days[dayIndex])}
      {@const active = interactive(dayIndex)}
      {@const day = series.days[dayIndex] ?? ""}
      {@const selected = day === selectedDay}
      <!-- Role/tabindex are set only for days with usage. -->
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
      <g
        class={["outline-none", active && "cursor-pointer"]}
        opacity={selectedDay && !selected ? 0.45 : 1}
        role={active ? "button" : undefined}
        tabindex={active ? 0 : undefined}
        aria-pressed={active ? selected : undefined}
        aria-label={active ? `${formatDayKey(day)}: ${formatMetric(totals[dayIndex] ?? 0, metric, estimated)}` : undefined}
        onmouseenter={(event) => show(event, dayIndex)}
        onmouseleave={() => { hovered = null; }}
        onfocus={(event) => show(event, dayIndex)}
        onblur={() => { hovered = null; }}
        onclick={() => toggleDay(dayIndex)}
        onkeydown={(event) => activateOnKey(event, () => toggleDay(dayIndex))}
      >
        <rect x={dayIndex * SLOT} y="0" width={SLOT} height={HEIGHT}
          fill="var(--foreground)" fill-opacity={selected ? 0.1 : hovered?.index === dayIndex ? 0.06 : 0} />
        {#each segments(row) as segment (segment.key)}
          <rect x={dayIndex * SLOT + (SLOT - BAR) / 2} y={segment.y} width={BAR} height={segment.h} fill={segment.color} />
        {/each}
      </g>
    {/each}
  </svg>
  <UsageTooltip anchor={hovered?.anchor ?? null} onDismiss={() => { hovered = null; }}>
    {#if hovered}
      <div class="flex items-baseline justify-between gap-3">
        <span class="font-medium">{formatDayKey(series.days[hovered.index] ?? "")}</span>
        <span class="tabular-nums">{formatMetric(totals[hovered.index] ?? 0, metric, estimated)}</span>
      </div>
      {#each hoveredRows as entry (entry.key)}
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="h-2 w-2 shrink-0 rounded-[2px]" style:background={entry.color} aria-hidden="true"></span>
          <span class="min-w-0 flex-1 truncate font-mono">{modelLabel(entry.key)}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">{formatMetric(entry.value, metric, estimated)}</span>
        </div>
      {/each}
      {#if interactive(hovered.index)}
        <div class="mt-0.5 text-muted-foreground">{series.days[hovered.index] === selectedDay ? "Click to clear the day filter" : "Click to filter by this day"}</div>
      {/if}
    {/if}
  </UsageTooltip>
  {#if series.days.length > 0}
    <div class="flex justify-between text-[10px] text-muted-foreground tabular-nums">
      <span>{formatDayKey(series.days[0]!)}</span>
      <span>max {formatMetric(series.max, metric, estimated)}/day</span>
      <span>{formatDayKey(series.days[series.days.length - 1]!)}</span>
    </div>
  {/if}
  {#if series.models.length > 0}
    <ul class="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11px] text-muted-foreground" aria-label="Models">
      {#each series.models as model, index (model)}
        <li class="flex min-w-0 items-center">
          {#if selectableModel(model)}
            <button
              type="button"
              class={["flex min-w-0 items-center gap-1 rounded-sm px-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                selectedModel === model && "font-medium text-foreground", selectedModel && selectedModel !== model && "opacity-60"]}
              aria-pressed={selectedModel === model}
              title={selectedModel === model ? "Clear the model filter" : `Filter by ${modelLabel(model)}`}
              onclick={() => onSelectModel?.(selectedModel === model ? null : model)}
            >
              <span class="h-2 w-2 shrink-0 rounded-[2px]" style:background={seriesColor(model, index)} aria-hidden="true"></span>
              <span class="max-w-[160px] truncate font-mono">{modelLabel(model)}</span>
            </button>
          {:else}
            <span class="flex min-w-0 items-center gap-1 px-0.5">
              <span class="h-2 w-2 shrink-0 rounded-[2px]" style:background={seriesColor(model, index)} aria-hidden="true"></span>
              <span class="max-w-[160px] truncate font-mono" title={modelLabel(model)}>{modelLabel(model)}</span>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</figure>
