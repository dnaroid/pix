<script lang="ts">
  import { onMount } from "svelte";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Minimize2 from "@lucide/svelte/icons/minimize-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ModelUsageLimitWindow, RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
  import { parseDcpContextMap } from "../lib/dcp-context-map";
  import {
    dcpContextMap,
    type DcpContextMapCellKind,
  } from "../lib/dcp-context-visualization";
  import {
    clampUsagePercent,
    contextUsageTone,
    dcpStatsBody,
    formatCompactTokens,
    formatResetDuration,
    modelUsageTone,
    modelUsageWindowWillExhaustBeforeReset,
    type UsageTone,
  } from "../lib/runtime-status";
  import {
    formatSessionUsageCost,
    formatSessionUsageTokens,
    sessionUsageHasValue,
  } from "../lib/session-usage";
  import { modelDisplayToneClass, modelRefTone } from "../lib/model-display";

  let {
    status,
    showSkeletons = false,
    workspacePath,
    workspaceName,
    workspaceBranch,
    loadingDcpStats = false,
    sessionUsage,
    loadingSessionUsage = false,
    sessionUsageFailed = false,
    sessionUsageAvailable = false,
    compressingContext = false,
    compressionAvailable = true,
    canCompressContext = true,
    onOpenSessionUsage,
    onOpenDcpStats,
    onCompressContext,
  }: {
    status?: RuntimeStatus;
    showSkeletons?: boolean;
    workspacePath?: string;
    workspaceName?: string;
    workspaceBranch?: string;
    loadingDcpStats?: boolean;
    sessionUsage?: SessionUsageReport;
    loadingSessionUsage?: boolean;
    sessionUsageFailed?: boolean;
    sessionUsageAvailable?: boolean;
    compressingContext?: boolean;
    compressionAvailable?: boolean;
    canCompressContext?: boolean;
    onOpenSessionUsage: () => void;
    onOpenDcpStats: () => void;
    onCompressContext: () => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let dcpOpen = $state(false);
  let usageOpen = $state(false);
  let now = $state(Date.now());
  const WEEKLY_DAY_SEGMENTS = 7;
  const contextPercent = $derived(status?.context?.percent);
  const contextTone = $derived(contextPercent === null || contextPercent === undefined ? undefined : contextUsageTone(contextPercent));
  const contextMap = $derived(dcpContextMap(status?.context, parseDcpContextMap(status?.dcpContextMap)));
  const contextLegend = $derived(contextLegendItems());
  const dcpBody = $derived(dcpStatsBody(status?.dcpStats));
  const usageWindowItems = $derived(usageWindows());

  onMount(() => {
    const timer = window.setInterval(() => now = Date.now(), 60_000);
    return () => window.clearInterval(timer);
  });

  function closeOutside(event: PointerEvent): void {
    if ((!dcpOpen && !usageOpen) || root?.contains(event.target as Node)) return;
    dcpOpen = false;
    usageOpen = false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && (dcpOpen || usageOpen)) {
      dcpOpen = false;
      usageOpen = false;
      event.stopPropagation();
    }
  }

  function toggleDcp(): void {
    const opening = !dcpOpen;
    dcpOpen = opening;
    if (opening) usageOpen = false;
    if (opening) onOpenDcpStats();
  }

  function toggleUsage(): void {
    const opening = !usageOpen;
    usageOpen = opening;
    if (opening) {
      dcpOpen = false;
      onOpenSessionUsage();
    }
  }

  $effect(() => {
    // Opening during session warm-up should not strand the popover in an
    // unloaded state. Once the runtime becomes requestable, load on demand.
    if (usageOpen && sessionUsageAvailable && !sessionUsage && !loadingSessionUsage && !sessionUsageFailed) {
      onOpenSessionUsage();
    }
  });

  function contextTitle(): string {
    const context = status?.context;
    const saved = status?.dcpTokensSaved;
    const savings = saved === undefined
      ? ""
      : ` · DCP saved ~${Math.round(saved).toLocaleString("en-US")} tokens`;
    if (!context) return `Context usage unavailable${savings}`;
    if (context.tokens === null || context.percent === null) return `Context usage unknown · window ${formatCompactTokens(context.contextWindow)}${savings}`;
    return `Context ${formatCompactTokens(context.tokens)} / ${formatCompactTokens(context.contextWindow)} tokens${savings} · click for DCP statistics`;
  }

  function toneTextClass(tone: UsageTone): string {
    if (tone === "error") return "text-tool-error";
    if (tone === "warning") return "text-tool-warning";
    return "text-muted-foreground";
  }

  function contextCellClass(kind: DcpContextMapCellKind): string {
    if (kind === "free") return "bg-border";
    if (kind === "retained" || kind === "occupied") return "bg-muted-foreground/45";
    if (kind === "candidate") return "bg-primary";
    if (kind === "protected") return "bg-tool-info";
    if (kind === "compressed") return "bg-tool-success";
    return "bg-muted";
  }

  function contextLegendItems(): Array<{ kind: DcpContextMapCellKind; label: string; value?: string }> {
    const categories = contextMap.categoryTokens;
    if (categories) {
      return [
        { kind: "retained", label: "Other occupied", value: `~${formatContextEstimate(categories.retained)}` },
        { kind: "candidate", label: "Candidates", value: `~${formatContextEstimate(categories.candidate)}` },
        { kind: "protected", label: "Protected tools", value: `~${formatContextEstimate(categories.protected)}` },
        { kind: "compressed", label: "Summaries", value: `~${formatContextEstimate(categories.compressed)}` },
        { kind: "free", label: "Free", value: `~${formatCompactTokens(contextMap.freeTokens ?? 0)}` },
      ];
    }
    if (contextMap.occupiedPercent !== undefined) {
      return [
        { kind: "occupied", label: "Occupied", value: `~${formatCompactTokens(contextMap.occupiedTokens ?? 0)}` },
        { kind: "free", label: "Free", value: `~${formatCompactTokens(contextMap.freeTokens ?? 0)}` },
      ];
    }
    return [{ kind: "unknown", label: "Capacity unknown" }];
  }

  function formatContextEstimate(tokens: number): string {
    return tokens > 0 && tokens < 1 ? "<1" : formatCompactTokens(tokens);
  }

  function weeklyDayLabels(window: ModelUsageLimitWindow): string[] {
    const durationMs = window.windowSeconds > 0
      ? window.windowSeconds * 1000
      : 7 * 24 * 60 * 60 * 1000;
    const startAt = window.resetAt - durationMs;
    const segmentMs = durationMs / WEEKLY_DAY_SEGMENTS;
    return Array.from({ length: WEEKLY_DAY_SEGMENTS }, (_, index) =>
      new Date(startAt + (index + 0.5) * segmentMs).toLocaleDateString(undefined, { weekday: "short" }),
    );
  }

  function limitTitle(label: "H" | "W", window: ModelUsageLimitWindow): string {
    const name = label === "H" ? "Hourly" : "Weekly";
    const weeklySlices = label === "W"
      ? ` · day slices ${weeklyDayLabels(window).join(" · ")} (aggregate quota, not per-day usage)`
      : "";
    return `${name} limit · ${Math.round(window.remainingPercent)}% remaining · resets ${formatResetDuration(window.resetAt, now)}${weeklySlices}`;
  }

  function usageWindows(): Array<{ label: "H" | "W"; window: ModelUsageLimitWindow }> {
    const windows: Array<{ label: "H" | "W"; window: ModelUsageLimitWindow }> = [];
    if (status?.modelUsage?.hourly) windows.push({ label: "H", window: status.modelUsage.hourly });
    if (status?.modelUsage?.weekly) windows.push({ label: "W", window: status.modelUsage.weekly });
    return windows;
  }

  function compressionTitle(): string {
    if (!compressionAvailable) return "DCP compression is unavailable for this session";
    if (!canCompressContext) return "DCP compression is available when the session is idle";
    return "Compress stale context with DCP";
  }
</script>

<svelte:window onpointerdown={closeOutside} onkeydown={handleKeydown} />

{#if status || workspaceName || showSkeletons}
  <div
    bind:this={root}
    class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 max-[900px]:flex"
    data-runtime-status
  >
    {#if status?.context || status?.dcpTokensSaved !== undefined}
      <div class="group relative col-start-1 shrink-0 justify-self-start" data-runtime-context>
        <button
          class="flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          type="button"
          aria-label={contextTitle()}
          aria-haspopup="dialog"
          aria-expanded={dcpOpen}
          aria-controls="runtime-dcp-popover"
          onclick={toggleDcp}
        >
          <span class="font-sans text-xs text-muted-foreground max-[860px]:hidden">Context</span>
          <span class={contextTone ? toneTextClass(contextTone) : "text-muted-foreground"}>{contextPercent === null || contextPercent === undefined ? "?%" : `${Math.round(contextPercent)}%`}</span>
          <span class="flex h-1.5 w-16 overflow-hidden rounded-sm bg-border" aria-hidden="true">
            {#each contextMap.cells as cell}
              <span class="flex h-full min-w-0 flex-1">
                {#each cell.segments as segment}
                  <span
                    class={["h-full min-w-0", contextCellClass(segment.kind)]}
                    style:flex-grow={segment.share}
                  ></span>
                {/each}
              </span>
            {/each}
          </span>
          {#if status?.dcpTokensSaved !== undefined}
            <span class="text-muted-foreground">saved ~{formatCompactTokens(status.dcpTokensSaved)}</span>
          {/if}
        </button>

        {#if !dcpOpen}
          <div
            class="pointer-events-none absolute bottom-[calc(100%+0.375rem)] left-0 z-40 hidden w-max max-w-[min(360px,calc(100vw-16px))] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
            role="tooltip"
          >
            <div class="font-mono text-xs text-muted-foreground">{contextTitle()}</div>
            <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Context color legend">
              {#each contextLegend as item}
                <span class="inline-flex items-center gap-1">
                  <i class={["h-2 w-2 shrink-0 rounded-[1px]", contextCellClass(item.kind)]} aria-hidden="true"></i>
                  <span>{item.label}{item.value ? ` ${item.value}` : ""}</span>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        {#if dcpOpen}
          <div
            id="runtime-dcp-popover"
            class="absolute bottom-[calc(100%+0.375rem)] left-0 z-50 w-[min(390px,calc(100vw-16px))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
            role="dialog"
            aria-label="DCP session statistics"
          >
            <header class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div class="min-w-0">
                <div class="text-xs font-medium text-foreground">DCP session statistics</div>
                {#if status?.context}
                  <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    Context {status.context.percent === null ? "unknown" : `${Math.round(status.context.percent)}%`}
                    {#if status.context.tokens !== null}
                      · {formatCompactTokens(status.context.tokens)} / {formatCompactTokens(status.context.contextWindow)}
                    {/if}
                  </div>
                  {/if}
              </div>
              <button
                class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border border-border bg-transparent px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-default disabled:opacity-45"
                type="button"
                title={compressionTitle()}
                aria-label="Compress stale context with DCP"
                aria-busy={compressingContext}
                disabled={!canCompressContext || compressingContext}
                onclick={onCompressContext}
              >
                {#if compressingContext}
                  <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span>Compressing…</span>
                {:else}
                  <Minimize2 class="h-3 w-3" aria-hidden="true" />
                  <span>Compress</span>
                {/if}
              </button>
            </header>
            <div class="max-h-[min(420px,55vh)] overflow-y-auto px-3 py-2.5">
              {#if dcpBody}
                <pre class="select-text whitespace-pre-wrap font-mono text-xs leading-[1.55] text-muted-foreground">{dcpBody}</pre>
              {:else if loadingDcpStats}
                <div class="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground" aria-live="polite">
                  <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span>Loading DCP telemetry…</span>
                </div>
              {:else}
                <p class="text-xs leading-4 text-muted-foreground">DCP telemetry is not available for this session yet.</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else if showSkeletons}
      <div
        class="col-start-1 flex h-6 shrink-0 items-center gap-1.5 justify-self-start px-1.5"
        data-runtime-context-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground max-[860px]:hidden">Context</span>
        <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-1.5 w-16 rounded-sm bg-border"></span>
        <span class="h-3 w-14 rounded-sm bg-muted-foreground/15"></span>
      </div>
    {/if}

    {#if workspaceName}
      <div
        class="col-start-2 flex min-w-0 max-w-[260px] items-center gap-1 justify-self-center px-1.5 font-mono text-xs"
        title={workspacePath ?? workspaceName}
        data-runtime-workspace
      >
        <span class="min-w-0 truncate text-foreground">{workspaceName}</span>
        {#if workspaceBranch}
          <span class="max-w-36 shrink truncate text-muted-foreground/55">({workspaceBranch})</span>
        {:else if showSkeletons}
          <span
            class="h-3 w-14 shrink-0 rounded-sm bg-muted-foreground/15"
            data-runtime-workspace-branch-skeleton
            aria-hidden="true"
          ></span>
        {/if}
      </div>
    {:else if showSkeletons}
      <div
        class="col-start-2 flex min-w-0 items-center gap-1 justify-self-center px-1.5"
        data-runtime-workspace-skeleton
        aria-hidden="true"
      >
        <span class="h-3 w-24 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-3 w-14 rounded-sm bg-muted-foreground/15"></span>
      </div>
    {/if}

    {#if sessionUsageAvailable || status?.modelUsage}
      <div class="relative col-start-3 shrink-0 justify-self-end">
        <button
          class="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          type="button"
          title="Session usage and cost"
          aria-label="Session usage and cost"
          aria-haspopup="dialog"
          aria-expanded={usageOpen}
          aria-controls="runtime-usage-popover"
          onclick={toggleUsage}
        >
          <span class="font-sans text-xs text-muted-foreground max-[900px]:hidden">Usage</span>
          {#if status?.modelUsage?.accountEmail}
            <span class="max-w-28 truncate text-muted-foreground max-[1100px]:hidden">{status.modelUsage.accountEmail}</span>
          {/if}
          {#each usageWindowItems as { label, window } (label)}
              {@const tone = modelUsageTone(window.remainingPercent)}
              {@const exhaustsEarly = modelUsageWindowWillExhaustBeforeReset(window, now)}
              <span class="flex items-center gap-1" title={limitTitle(label, window)}>
                {#if usageWindowItems.length > 1}
                  <span class="text-muted-foreground">{label === "H" ? "Hourly" : "Weekly"}</span>
                {/if}
                <span
                  class={["relative h-1.5 overflow-hidden rounded-sm bg-border", label === "W" ? "w-14" : "w-8"]}
                  aria-hidden="true"
                >
                  <span
                    class="absolute inset-y-0 left-0 bg-muted-foreground/50"
                    style={`width: ${clampUsagePercent(window.remainingPercent)}%`}
                  ></span>
                  {#if label === "W"}
                    <span class="absolute inset-0 grid grid-cols-7">
                      {#each Array.from({ length: WEEKLY_DAY_SEGMENTS }) as _, index}
                        <i class={index === 0 ? "" : "border-l border-background/80"}></i>
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class={toneTextClass(tone)}>{Math.round(window.remainingPercent)}%</span>
                {#if exhaustsEarly}
                  <TriangleAlert class="h-2.5 w-2.5 text-tool-warning" aria-label="Projected to exhaust before reset" />
                {/if}
                <span class="text-muted-foreground max-[980px]:hidden">resets {formatResetDuration(window.resetAt, now)}</span>
              </span>
          {/each}
        </button>

        {#if usageOpen}
          <div
            id="runtime-usage-popover"
            class="absolute right-0 bottom-[calc(100%+0.375rem)] z-50 w-[min(360px,calc(100vw-16px))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
            role="dialog"
            aria-label="Session usage and cost"
          >
            <header class="border-b border-border px-3 py-2">
              <div class="text-xs font-medium text-foreground">Session usage</div>
              <div class="mt-0.5 font-mono text-xs text-muted-foreground">
                {#if sessionUsage}
                  {formatSessionUsageCost(sessionUsage.totals.cost)} · {formatSessionUsageTokens(sessionUsage.totals.totalTokens)} tokens
                {:else if loadingSessionUsage}
                  Loading recorded usage…
                {:else if sessionUsageFailed}
                  Could not load recorded usage.
                {:else if sessionUsageAvailable}
                  Loading recorded usage…
                {:else}
                  Session runtime is still loading.
                {/if}
              </div>
            </header>
            <div class="max-h-[min(460px,60vh)] overflow-y-auto px-3 py-2.5 text-xs">
              {#if loadingSessionUsage && !sessionUsage}
                <div class="flex items-center gap-1.5 text-muted-foreground" aria-live="polite">
                  <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span>Loading session usage…</span>
                </div>
              {:else if sessionUsageFailed && !sessionUsage}
                <div class="flex items-center justify-between gap-3 text-muted-foreground" aria-live="polite">
                  <span>The session usage request failed.</span>
                  <button
                    class="shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    type="button"
                    onclick={onOpenSessionUsage}
                  >Retry</button>
                </div>
              {:else if sessionUsage}
                <section class="space-y-2.5">
                  {#if sessionUsage.providers.length === 0 && !sessionUsageHasValue(sessionUsage.unattributed)}
                    <p class="text-muted-foreground">No billable usage has been recorded for this session yet.</p>
                  {:else}
                    {#each sessionUsage.providers as provider (provider.provider)}
                      <div>
                        <div class="mb-1 text-xs font-medium text-muted-foreground">{provider.provider}</div>
                        <div class="space-y-1">
                          {#each provider.models as model (`${provider.provider}/${model.model}`)}
                            <div class="flex min-w-0 items-center justify-between gap-3 font-mono tabular-nums">
                              <span
                                class={["min-w-0 truncate font-medium", modelDisplayToneClass(modelRefTone(`${provider.provider}/${model.model}`))]}
                                title={`${provider.provider}/${model.model}`}
                              >{model.model}</span>
                              <span class="shrink-0 text-foreground">{formatSessionUsageTokens(model.totals.totalTokens)} · {formatSessionUsageCost(model.totals.cost)}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/each}
                    {#if sessionUsageHasValue(sessionUsage.unattributed)}
                      <div class="flex items-center justify-between gap-3 border-t border-border pt-2 text-muted-foreground">
                        <span>Unattributed</span>
                        <span class="font-mono tabular-nums">{formatSessionUsageTokens(sessionUsage.unattributed.totalTokens)} · {formatSessionUsageCost(sessionUsage.unattributed.cost)}</span>
                      </div>
                    {/if}
                  {/if}
                </section>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else if showSkeletons}
      <div
        class="col-start-3 flex h-6 shrink-0 items-center gap-1.5 justify-self-end px-1.5 font-mono text-xs"
        data-runtime-usage-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground max-[900px]:hidden">Usage</span>
        <span class="h-1.5 w-8 rounded-sm bg-border"></span>
        <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-3 w-16 rounded-sm bg-muted-foreground/15 max-[980px]:hidden"></span>
      </div>
    {/if}
  </div>
{/if}
