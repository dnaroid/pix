<script lang="ts">
  import type { UsageCalendar, UsageCalendarDay, UsageMetric } from "../../lib/usage-stats";
  import UsageTooltip from "./UsageTooltip.svelte";
  import { activateOnKey, anchorOf, type UsageTooltipAnchor } from "./usage-interaction";
  import { formatDayKey, formatMetric, monthLabel, weekdayLabels } from "./usage-format";

  let { calendar, metric, estimated = false, selectedDay = null, onSelectDay }: {
    calendar: UsageCalendar;
    metric: UsageMetric;
    estimated?: boolean;
    selectedDay?: string | null;
    onSelectDay?: (day: string | null) => void;
  } = $props();

  // Rows follow the locale week start; label Mon/Wed/Fri like GitHub.
  const DAY_LABELS = $derived(weekdayLabels(undefined, calendar.weekStart)
    .map((label, row) => [1, 3, 5].includes((calendar.weekStart + row) % 7) ? label : ""));
  const LABEL = 26;
  const TOP = 12;
  const GAP = 2;
  // One cell size for every period keeps the calendar height stable; long
  // periods scroll horizontally instead of shrinking.
  const cell = 14;
  const step = $derived(cell + GAP);
  const width = $derived(LABEL + calendar.weeks.length * step);
  const height = $derived(TOP + 7 * step);

  const monthLabels = $derived.by(() => {
    const labels: { x: number; text: string }[] = [];
    let previous = -1;
    calendar.weeks.forEach((week, index) => {
      const first = week.find((day) => day !== null);
      if (!first) return;
      const month = Number(first.key.slice(5, 7)) - 1;
      if (month !== previous) {
        const label = { x: LABEL + index * step, text: monthLabel(month) };
        const last = labels.at(-1);
        if (!last || label.x - last.x >= 3 * step) labels.push(label);
        // A partial leading month must not hide the first full month (GitHub-style).
        else if (labels.length === 1 && last.x === LABEL) labels[0] = label;
      }
      previous = month;
    });
    return labels;
  });
  const activeDays = $derived(calendar.weeks.flat().filter((day) => day !== null && !day.outside && day.value > 0).length);
  const totalDays = $derived(calendar.weeks.flat().filter((day) => day !== null && !day.outside).length);
  const summary = $derived(calendar.total > 0
    ? `Daily activity calendar: ${activeDays} of ${totalDays} days active, ${formatMetric(calendar.total, metric, estimated)} total.`
    : "No daily activity in this period.");

  let scroller = $state<HTMLElement | null>(null);
  // Keep the most recent weeks in view, like GitHub.
  $effect(() => {
    void width;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  });

  let hovered = $state<{ day: UsageCalendarDay; anchor: UsageTooltipAnchor } | null>(null);
  // New data invalidates the hovered geometry.
  $effect(() => { void calendar; hovered = null; });

  function opacity(value: number): number {
    return calendar.max > 0 ? 0.18 + 0.82 * Math.sqrt(value / calendar.max) : 0;
  }

  function interactive(day: UsageCalendarDay): boolean {
    return onSelectDay !== undefined && !day.outside && (day.value > 0 || day.key === selectedDay);
  }

  function toggle(day: UsageCalendarDay): void {
    if (interactive(day)) onSelectDay?.(day.key === selectedDay ? null : day.key);
  }

  function show(event: Event, day: UsageCalendarDay): void {
    hovered = { day, anchor: anchorOf(event.currentTarget as Element) };
  }
</script>

<figure class="m-0">
  <div bind:this={scroller} class="overflow-x-auto">
    <svg class="block" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={summary}>
      {#each monthLabels as label (label.x)}
        <text x={label.x} y="9" class="fill-muted-foreground text-[10px]" aria-hidden="true">{label.text}</text>
      {/each}
      {#each DAY_LABELS as label, day (day)}
        {#if label}<text x="0" y={TOP + day * step + cell - 1} class="fill-muted-foreground text-[10px]" aria-hidden="true">{label}</text>{/if}
      {/each}
      {#each calendar.weeks as week, column (column)}
        {#each week as day, row (row)}
          {#if day?.outside}
            <rect
              x={LABEL + column * step + 0.5} y={TOP + row * step + 0.5} width={cell - 1} height={cell - 1} rx="2"
              fill="none" stroke="var(--foreground)" stroke-opacity="0.12" stroke-width="1" aria-hidden="true"
            />
          {:else if day}
            {@const active = interactive(day)}
            {@const selected = day.key === selectedDay}
            {@const emphasized = selected || hovered?.day.key === day.key}
            <!-- Role/tabindex are set only for interactive (non-empty) days. -->
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
            <rect
              x={LABEL + column * step} y={TOP + row * step} width={cell} height={cell} rx="2"
              class={["outline-none", active && "cursor-pointer"]}
              fill={day.value > 0 ? "var(--tool-info)" : "var(--foreground)"}
              fill-opacity={day.value > 0 ? (selectedDay && !selected ? opacity(day.value) * 0.45 : opacity(day.value)) : EMPTY_OPACITY}
              stroke={emphasized ? "var(--ring)" : "none"} stroke-width={selected ? 1.5 : 1}
              role={active ? "button" : undefined}
              tabindex={active ? 0 : undefined}
              aria-pressed={active ? selected : undefined}
              aria-label={active ? `${formatDayKey(day.key)}: ${formatMetric(day.value, metric, estimated)}` : undefined}
              onmouseenter={(event) => show(event, day)}
              onmouseleave={() => { hovered = null; }}
              onfocus={(event) => show(event, day)}
              onblur={() => { hovered = null; }}
              onclick={() => toggle(day)}
              onkeydown={(event) => activateOnKey(event, () => toggle(day))}
            />
          {/if}
        {/each}
      {/each}
    </svg>
  </div>
  <UsageTooltip anchor={hovered?.anchor ?? null} onDismiss={() => { hovered = null; }}>
    {#if hovered}
      <div class="font-medium">{formatDayKey(hovered.day.key)}</div>
      <div class="tabular-nums">{formatMetric(hovered.day.value, metric, estimated)}</div>
      {#if interactive(hovered.day)}
        <div class="mt-0.5 text-muted-foreground">{hovered.day.key === selectedDay ? "Click to clear the day filter" : "Click to filter by this day"}</div>
      {/if}
    {/if}
  </UsageTooltip>
</figure>

<script lang="ts" module>
  // Empty days stay visible as a faint grid; --muted matches the panel background in dark mode.
  const EMPTY_OPACITY = 0.07;
</script>
