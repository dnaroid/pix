<script lang="ts">
  import type { UsageHourProfile, UsageMetric } from "../../lib/usage-stats";
  import UsageTooltip from "./UsageTooltip.svelte";
  import { activateOnKey, anchorOf, type UsageTooltipAnchor } from "./usage-interaction";
  import { formatHour, formatHourTick, formatMetric } from "./usage-format";

  let { profile, metric, estimated = false, selectedHour = null, onSelectHour }: {
    profile: UsageHourProfile;
    metric: UsageMetric;
    estimated?: boolean;
    selectedHour?: number | null;
    onSelectHour?: (hour: number | null) => void;
  } = $props();

  const SLOT = 12;
  const BAR = 10;
  const HEIGHT = 28;
  const width = 24 * SLOT;
  const peak = $derived(profile.hours.reduce((best, value, hour) => value > (profile.hours[best] ?? 0) ? hour : best, 0));
  const summary = $derived(profile.total > 0
    ? `Activity by hour of day; busiest ${formatHour(peak)} with ${formatMetric(profile.hours[peak] ?? 0, metric, estimated)}.`
    : "No hourly activity in this period.");

  let hovered = $state<{ hour: number; anchor: UsageTooltipAnchor } | null>(null);
  $effect(() => { void profile; hovered = null; });

  function interactive(hour: number): boolean {
    return onSelectHour !== undefined && ((profile.hours[hour] ?? 0) > 0 || hour === selectedHour);
  }

  function toggle(hour: number): void {
    if (interactive(hour)) onSelectHour?.(hour === selectedHour ? null : hour);
  }

  function show(event: Event, hour: number): void {
    hovered = { hour, anchor: anchorOf(event.currentTarget as Element) };
  }
</script>

<figure class="m-0 flex flex-col gap-1">
  <figcaption class="text-[11px] text-muted-foreground">By hour of day</figcaption>
  <svg class="block h-auto w-full max-w-[288px]" viewBox={`0 0 ${width} ${HEIGHT + 12}`} role="group" aria-label={summary}>
    {#each profile.hours as value, hour (hour)}
      {@const h = profile.max > 0 && value > 0 ? Math.max(1.5, (value / profile.max) * HEIGHT) : 1.5}
      {@const active = interactive(hour)}
      {@const selected = hour === selectedHour}
      <!-- Role/tabindex are set only for hours with usage. -->
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
      <g
        class={["outline-none", active && "cursor-pointer"]}
        role={active ? "button" : undefined}
        tabindex={active ? 0 : undefined}
        aria-pressed={active ? selected : undefined}
        aria-label={active ? `${formatHour(hour)}: ${formatMetric(value, metric, estimated)}` : undefined}
        onmouseenter={(event) => show(event, hour)}
        onmouseleave={() => { hovered = null; }}
        onfocus={(event) => show(event, hour)}
        onblur={() => { hovered = null; }}
        onclick={() => toggle(hour)}
        onkeydown={(event) => activateOnKey(event, () => toggle(hour))}
      >
        <rect x={hour * SLOT} y="0" width={SLOT} height={HEIGHT}
          fill="var(--foreground)" fill-opacity={selected ? 0.1 : hovered?.hour === hour ? 0.06 : 0} />
        <rect
          x={hour * SLOT + (SLOT - BAR) / 2} y={HEIGHT - h} width={BAR} height={h} rx="1.5"
          fill={value > 0 ? "var(--tool-info)" : "var(--foreground)"}
          fill-opacity={value > 0 ? (selectedHour !== null && !selected ? 0.35 : 0.85) : 0.07}
        />
      </g>
    {/each}
    {#each [0, 6, 12, 18] as hour (hour)}
      <text x={hour * SLOT} y={HEIGHT + 11} class="fill-muted-foreground text-[10px]" aria-hidden="true">{formatHourTick(hour)}</text>
    {/each}
  </svg>
  <UsageTooltip anchor={hovered?.anchor ?? null} onDismiss={() => { hovered = null; }}>
    {#if hovered}
      {@const value = profile.hours[hovered.hour] ?? 0}
      <div class="font-medium">{formatHour(hovered.hour)}–{formatHour((hovered.hour + 1) % 24)}</div>
      <div class="tabular-nums">
        {formatMetric(value, metric, estimated)}{#if profile.total > 0}<span class="text-muted-foreground"> · {Math.round((value / profile.total) * 100)}%</span>{/if}
      </div>
      {#if interactive(hovered.hour)}
        <div class="mt-0.5 text-muted-foreground">{hovered.hour === selectedHour ? "Click to clear the hour filter" : "Click to filter by this hour"}</div>
      {/if}
    {/if}
  </UsageTooltip>
</figure>
