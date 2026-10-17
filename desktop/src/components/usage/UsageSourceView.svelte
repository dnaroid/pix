<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import type { UsageSourceSnapshot } from "../../../../acp/src/acp/usage-stats-contract";
  import {
    availableMetrics, bucketDayKey, cacheEfficiency, currentWeekWindow, dailyByModel, filterByTime, metricValue, modelOptions, modelShares,
    calendarHeatmap, hourOfDayProfile, periodWindow, selectBuckets, sumValues, topSessions,
    type UsageMetric, type UsagePeriod, type UsageScope, type UsageSelection, type UsageSessionTarget,
  } from "../../lib/usage-stats";
  import TaskFieldSelect from "../TaskFieldSelect.svelte";
  import UsageDailyBars from "./UsageDailyBars.svelte";
  import UsageHeatmap from "./UsageHeatmap.svelte";
  import UsageHourStrip from "./UsageHourStrip.svelte";
  import UsageSection from "./UsageSection.svelte";
  import UsageSegmented from "./UsageSegmented.svelte";
  import UsageShareList from "./UsageShareList.svelte";
  import {
    METRIC_LABELS, SOURCE_LABELS, STATUS_LABELS, UNIT_LABELS,
    formatDate, formatDayKey, formatHour, formatMetric, formatRelative, localWeekStart, modelLabel, pathBasename,
  } from "./usage-format";

  let { snapshot, period, nowMs, workspace, onOpenSession }: {
    snapshot: UsageSourceSnapshot;
    period: UsagePeriod;
    nowMs: number;
    workspace: string;
    onOpenSession?: (target: UsageSessionTarget) => void;
  } = $props();

  /** `""` = all models. */
  let model = $state("");
  let metricChoice = $state<UsageMetric | null>(null);
  let scope = $state<UsageScope>("project");
  const weekStart = localWeekStart();
  /** Chart cross-filters: local day (`YYYY-MM-DD`) and local hour of day. */
  let dayChoice = $state<string | null>(null);
  let hourChoice = $state<number | null>(null);

  const metrics = $derived(availableMetrics(snapshot));
  const metric = $derived<UsageMetric>(metricChoice && metrics.includes(metricChoice)
    ? metricChoice
    : metrics[0] ?? "tokens");
  // Pix sessions cover every project; scope by the session header cwd.
  const scoped = $derived(snapshot.buckets.some((bucket) => bucket.projectCwd !== undefined));
  const models = $derived(modelOptions(snapshot, metric));
  const selectedModel = $derived(model !== "" && models.some((option) => option.key === model) ? model : null);
  const range = $derived(periodWindow(period, nowMs, snapshot.coverage));
  // A rolling 7-day window splits across two calendar columns; show the current week instead.
  const calendarRange = $derived(period === "7d" ? currentWeekWindow(nowMs, weekStart) : range);
  const selection = $derived<UsageSelection>({
    period, nowMs, model: selectedModel, scope: scoped ? scope : "all", cwd: workspace,
  });
  // Period + scope + model; charts keep the full period so a selected day stays visible.
  const periodBuckets = $derived(selectBuckets(snapshot, selection));
  const periodTotals = $derived(sumValues(periodBuckets));
  const periodTotal = $derived(metricValue(periodTotals, metric));
  const estimated = $derived(periodTotals.costEstimated === true);
  // A day outside the current period/scope/model silently stops filtering.
  const selectedDay = $derived(dayChoice !== null && periodBuckets.some((bucket) => bucket.startMs !== 0 && bucketDayKey(bucket) === dayChoice) ? dayChoice : null);
  const selectedHour = $derived(hourChoice !== null && periodBuckets.some((bucket) => bucket.width === "hour" && bucket.startMs !== 0 && new Date(bucket.startMs).getHours() === hourChoice) ? hourChoice : null);
  const timeFilter = $derived({ day: selectedDay, hour: selectedHour });
  // Fully filtered: KPIs, top sessions and cache efficiency.
  const buckets = $derived(filterByTime(periodBuckets, timeFilter));
  const totals = $derived(sumValues(buckets));
  // Each chart applies every filter except its own axis.
  const byHour = $derived(filterByTime(periodBuckets, { hour: selectedHour }));
  const calendar = $derived(calendarHeatmap(byHour, metric, calendarRange, nowMs, weekStart));
  const daily = $derived(dailyByModel(byHour, metric, range, nowMs));
  const hourProfile = $derived(hourOfDayProfile(filterByTime(periodBuckets, { day: selectedDay }), metric));
  const shares = $derived(modelShares(filterByTime(selectBuckets(snapshot, { ...selection, model: null }), timeFilter), metric));
  const sessions = $derived(topSessions(buckets, snapshot.sessions, metric));
  const sessionCount = $derived(new Set(buckets.map((bucket) => bucket.sessionId).filter(Boolean)).size);
  const cache = $derived(cacheEfficiency(totals));
  const kpis = $derived([
    totals.cost ? { label: estimated ? "Cost (estimate)" : "Cost", value: formatMetric(totals.cost, "cost", estimated) } : null,
    metricValue(totals, "tokens") > 0 ? { label: "Tokens", value: formatMetric(metricValue(totals, "tokens"), "tokens") } : null,
    totals.calls ? { label: "Calls", value: formatMetric(totals.calls, "calls") } : null,
    sessionCount > 0 ? { label: "Sessions", value: String(sessionCount) } : null,
  ].filter((kpi): kpi is { label: string; value: string } => kpi !== null));
  const granularity = $derived(buckets.some((bucket) => bucket.width === "hour") ? "hourly" : "daily");
  const provenance = $derived([
    SOURCE_LABELS[snapshot.source], UNIT_LABELS[snapshot.unit], granularity,
    `updated ${formatRelative(snapshot.fetchedAtMs, nowMs)}`, ...(estimated ? ["≈ API-equivalent cost"] : []),
  ].join(" · "));
  const modelSelectOptions = $derived([
    { value: "", label: "All models" },
    ...models.map((option) => ({ value: option.key, label: modelLabel(option.key), description: formatMetric(option.value, metric, estimated) })),
  ]);

  // Desktop windows are bound to one workspace; sessions of other projects
  // cannot be loaded into this window, so only current-project rows open.
  function canOpenSession(session: { projectCwd?: string }): boolean {
    return session.projectCwd === undefined || session.projectCwd === workspace;
  }

  function selectModel(key: string | null): void {
    model = key ?? "";
  }

  function sessionLabel(session: { sessionId: string; name?: string; projectCwd?: string }): string {
    return session.name || (session.projectCwd ? pathBasename(session.projectCwd) : session.sessionId.slice(0, 8));
  }
</script>

<div class="flex flex-col">
  <div class="flex flex-wrap items-center gap-1.5 px-3 py-2">
    {#if metrics.length > 1}
      <UsageSegmented value={metric} options={metrics.map((value) => ({ value, label: METRIC_LABELS[value] }))} ariaLabel="Metric" onChange={(value) => metricChoice = value} />
    {/if}
    {#if scoped}
      <UsageSegmented value={scope} options={[{ value: "project", label: "This project" }, { value: "all", label: "All projects" }]} ariaLabel="Project scope" onChange={(value) => scope = value} />
    {/if}
    {#if models.length > 1}
      <TaskFieldSelect
        value={selectedModel ?? ""} options={modelSelectOptions} onChange={(value) => model = value}
        ariaLabel="Model filter" size="xs" mono searchable={models.length > 8}
        searchPlaceholder="Search models…" emptyLabel="No matching models" popupMinWidth={220}
      />
    {/if}
  </div>

  {#if selectedDay !== null || selectedHour !== null}
    <div class="flex flex-wrap items-center gap-1.5 px-3 pb-2" aria-label="Active chart filters">
      {#if selectedDay !== null}
        <button type="button" class="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-panel-selected px-1.5 text-[11px] text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" title="Clear the day filter" onclick={() => dayChoice = null}>
          <span class="tabular-nums">{formatDayKey(selectedDay)}</span><X class="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </button>
      {/if}
      {#if selectedHour !== null}
        <button type="button" class="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-panel-selected px-1.5 text-[11px] text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" title="Clear the hour filter" onclick={() => hourChoice = null}>
          <span class="tabular-nums">{formatHour(selectedHour)}–{formatHour((selectedHour + 1) % 24)}</span><X class="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </button>
      {/if}
    </div>
  {/if}
  <p class="m-0 px-3 pb-2 text-[11px] leading-4 text-muted-foreground">{provenance}</p>
  {#if snapshot.status !== "ready"}
    <p class="m-0 border-l-2 border-tool-warning mx-3 mb-2 px-2 py-1 text-[11px] leading-4 text-muted-foreground" role="status">
      {STATUS_LABELS[snapshot.status]}{snapshot.message ? ` — ${snapshot.message}` : ""}
    </p>
  {/if}
  {#if range.truncated && snapshot.coverage}
    <p class="m-0 px-3 pb-2 text-[11px] leading-4 text-muted-foreground">This source only covers data since {formatDate(snapshot.coverage.fromMs)}.</p>
  {/if}

  {#if periodTotal <= 0 && kpis.length === 0}
    <p class="m-0 border-t border-sidebar-border px-3 py-6 text-center text-xs text-muted-foreground">No usage in this period.</p>
  {:else}
    <UsageSection title="Overview" sectionId="overview">
      <dl class="m-0 grid grid-cols-2 gap-x-3 gap-y-2">
        {#each kpis as kpi (kpi.label)}
          <div class="min-w-0"><dt class="text-[11px] text-muted-foreground">{kpi.label}</dt><dd class="m-0 truncate text-sm font-medium tabular-nums">{kpi.value}</dd></div>
        {/each}
      </dl>
    </UsageSection>
    {#if calendar.total > 0 || (hourProfile && hourProfile.total > 0)}
      <UsageSection title="Activity" sectionId="activity">
        <div class="flex flex-col gap-3">
          <UsageHeatmap {calendar} {metric} {estimated} {selectedDay} onSelectDay={(day) => dayChoice = day} />
          {#if hourProfile && hourProfile.total > 0}<UsageHourStrip profile={hourProfile} {metric} {estimated} {selectedHour} onSelectHour={(hour) => hourChoice = hour} />{/if}
        </div>
      </UsageSection>
    {/if}
    {#if daily.days.length > 0 && daily.max > 0}
      <UsageSection title={`Daily ${METRIC_LABELS[metric].toLowerCase()}`} sectionId="daily"><UsageDailyBars series={daily} {metric} {estimated} {selectedDay} {selectedModel} onSelectDay={(day) => dayChoice = day} onSelectModel={selectModel} /></UsageSection>
    {/if}
    {#if shares.length > 1 || selectedModel !== null}
      <UsageSection title="By model" sectionId="models"><UsageShareList {shares} {metric} {estimated} ariaLabel="Share by model" selected={selectedModel} onSelect={selectModel} /></UsageSection>
    {/if}
    {#if sessions.length > 0}
      <UsageSection title="Top sessions" sectionId="sessions">
        <ol class="m-0 flex list-none flex-col p-0">
          {#each sessions as session (session.sessionId)}
            <li>
              {#if onOpenSession && canOpenSession(session)}
                <button type="button" class="flex w-full min-w-0 items-baseline gap-2 rounded-sm px-1 py-1 text-left text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" title={`Open ${sessionLabel(session)}`} onclick={() => onOpenSession({ sessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) })}>
                  <span class="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                  {#if session.lastAtMs}<span class="shrink-0 text-[11px] text-muted-foreground">{formatRelative(session.lastAtMs, nowMs)}</span>{/if}
                  <span class="shrink-0 text-muted-foreground tabular-nums">{formatMetric(session.value, metric, estimated)}</span>
                </button>
              {:else}
                <div class="flex min-w-0 items-baseline gap-2 px-1 py-1 text-xs" title={session.projectCwd && session.projectCwd !== workspace ? `${session.projectCwd} (other project)` : session.sessionId}>
                  <span class="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                  {#if session.lastAtMs}<span class="shrink-0 text-[11px] text-muted-foreground">{formatRelative(session.lastAtMs, nowMs)}</span>{/if}
                  <span class="shrink-0 text-muted-foreground tabular-nums">{formatMetric(session.value, metric, estimated)}</span>
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      </UsageSection>
    {/if}
    {#if cache}
      <UsageSection title="Cache efficiency" sectionId="cache">
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between text-xs">
            <span>Cache hit rate</span><span class="font-medium tabular-nums">{Math.round(cache.hitRate * 100)}%</span>
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div class="h-full rounded-full bg-tool-success" style:width={`${cache.hitRate * 100}%`}></div></div>
          <p class="m-0 text-[11px] text-muted-foreground">{formatMetric(cache.cacheRead, "tokens")} read from cache of {formatMetric(cache.prompt, "tokens")} prompt.</p>
        </div>
      </UsageSection>
    {/if}
  {/if}
</div>
