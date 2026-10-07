<script lang="ts">
  import { onMount } from "svelte";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
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
    displayModelUsage,
    formatCompactTokens,
    formatResetDuration,
    limitingRateWindow,
    modelUsageTone,
    modelUsageWindowLabel,
    modelUsageWindowWillExhaustBeforeReset,
    shortModelUsageAccountLabel,
    type UsageTone,
  } from "../lib/runtime-status";
  import {
    formatSessionUsageCost,
    formatSessionUsageTokens,
    sessionUsageHasValue,
    providerUsageUrl,
  } from "../lib/session-usage";
  import { openExternalHref } from "../lib/external-links";
  import { modelDisplayToneClass, modelProviderBrand, modelRefTone } from "../lib/model-display";
  import ModelProviderIcon from "./ModelProviderIcon.svelte";
  import ModelUsageDonut from "./ModelUsageDonut.svelte";
  import QuotaResetCalendar from "./QuotaResetCalendar.svelte";
  import ResetCreditsSection from "./ResetCreditsSection.svelte";
  import UsageLimitBars from "./UsageLimitBars.svelte";

  let {
    status,
    showSkeletons = false,
    sessionUsage,
    loadingSessionUsage = false,
    sessionUsageFailed = false,
    sessionUsageAvailable = false,
    claudeCodeRoute = false,
    claudeLimitsRefreshing = false,
    claudeLimitsFailed = false,
    quotaWaitIndicator = null,
    onOpenSessionUsage,
    onRefreshClaudeLimits = () => {},
  }: {
    status?: RuntimeStatus;
    showSkeletons?: boolean;
    sessionUsage?: SessionUsageReport;
    loadingSessionUsage?: boolean;
    sessionUsageFailed?: boolean;
    sessionUsageAvailable?: boolean;
    /** Active session model routes through pi-claude-code-provider. */
    claudeCodeRoute?: boolean;
    claudeLimitsRefreshing?: boolean;
    claudeLimitsFailed?: boolean;
    quotaWaitIndicator?: { label: string; onReopen: () => void } | null;
    onOpenSessionUsage: () => void;
    onRefreshClaudeLimits?: () => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let contextOpen = $state(false);
  let usageOpen = $state(false);
  let now = $state(Date.now());
  let usageLinkFailed = $state(false);
  let usageLinkRequest = 0;
  const WEEKLY_DAY_SEGMENTS = 7;
  const savedTokensFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 });
  const contextPercent = $derived(status?.context?.percent);
  const showSavings = $derived((status?.dcpTokensSaved ?? 0) > 0);
  const contextTone = $derived(contextPercent === null || contextPercent === undefined ? undefined : contextUsageTone(contextPercent));
  const contextMap = $derived(dcpContextMap(status?.context, parseDcpContextMap(status?.dcpContextMap)));
  const contextLegend = $derived(contextLegendItems());
  // Quota usage wins while the provider quota is the freshest observation;
  // an API-key header snapshot pushed after a mid-session auth switch (or a
  // quota left over from a previous model) must not stay hidden behind it.
  const modelUsage = $derived(displayModelUsage(status, now));
  const usageAccountLabel = $derived(shortModelUsageAccountLabel(modelUsage?.accountEmail));
  const usageWindowItems = $derived(usageWindows());
  // Account quota bars show both remaining balances; the calendar below
  // keeps the exact weekly reset date. Header-derived rate windows remain
  // trigger-only because they are request-level observations.
  const popupLimitWindows = $derived(
    usageWindowItems.filter((item): item is { key: string; label: "H" | "W"; window: ModelUsageLimitWindow } => item.label === "H" || item.label === "W"),
  );
  const donutModels = $derived(
    (sessionUsage?.providers ?? []).flatMap((provider) =>
      provider.models.map((model) => ({ provider: provider.provider, model: model.model, totalTokens: model.totals.totalTokens })),
    ),
  );

  onMount(() => {
    const timer = window.setInterval(() => now = Date.now(), 60_000);
    return () => {
      window.clearInterval(timer);
    };
  });

  function closeOutside(event: PointerEvent): void {
    if ((!contextOpen && !usageOpen) || root?.contains(event.target as Node)) return;
    contextOpen = false;
    usageOpen = false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && (contextOpen || usageOpen)) {
      event.preventDefault();
      const panel = root?.querySelector<HTMLElement>(contextOpen ? '[data-context-region] button' : '[data-usage-region] button');
      panel?.focus();
      contextOpen = false;
      usageOpen = false;
      event.stopPropagation();
    }
  }

  function toggleContext(): void {
    contextOpen = !contextOpen;
    usageOpen = false;
  }

  function toggleUsage(): void {
    if (usageOpen) {
      usageOpen = false;
      return;
    }
    usageLinkRequest += 1;
    usageOpen = true;
    usageLinkFailed = false;
    contextOpen = false;
    onOpenSessionUsage();
  }

  function leaveDetails(event: FocusEvent, panel: "context" | "usage"): void {
    const region = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && region.contains(event.relatedTarget)) return;
    if (panel === "context") contextOpen = false;
    else usageOpen = false;
  }

  async function openProviderUsage(url: string): Promise<void> {
    const request = ++usageLinkRequest;
    const openedForUsage = sessionUsage;
    usageLinkFailed = false;
    try {
      await openExternalHref(url);
    } catch {
      if (usageOpen && request === usageLinkRequest && sessionUsage === openedForUsage) {
        usageLinkFailed = true;
      }
    }
  }

  $effect(() => {
    // Opening during session warm-up should not strand the popover in an
    // unloaded state. Once the runtime becomes requestable, load on demand.
    if (usageOpen && sessionUsageAvailable && !sessionUsage && !loadingSessionUsage && !sessionUsageFailed) {
      onOpenSessionUsage();
    }
  });

  function contextTitle(includeSavings = true): string {
    const context = status?.context;
    const saved = status?.dcpTokensSaved;
    const savings = saved === undefined || !includeSavings
      ? ""
      : ` · DCP saved ~${savedTokensFormatter.format(saved)} tokens`;
    if (!context) return `Context usage unavailable${savings}`;
    if (context.tokens === null || context.percent === null) return `Context usage unknown · window ${formatCompactTokens(context.contextWindow)}${savings}`;
    return `Context ${formatCompactTokens(context.tokens)} / ${formatCompactTokens(context.contextWindow)} tokens${savings}`;
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

  function contextStrokeClass(kind: DcpContextMapCellKind): string {
    if (kind === "free") return "stroke-border";
    if (kind === "retained" || kind === "occupied") return "stroke-muted-foreground/45";
    if (kind === "candidate") return "stroke-primary";
    if (kind === "protected") return "stroke-tool-info";
    if (kind === "compressed") return "stroke-tool-success";
    return "stroke-muted";
  }

  /** Ring segments as a share (0-100) of the context window, in legend order. The unfilled
   *  remainder renders as the base ring, so "free" is intentionally not a drawn segment. */
  function ringSegments(): Array<{ kind: DcpContextMapCellKind; pct: number }> {
    const total = status?.context?.contextWindow;
    if (!total || contextMap.occupiedPercent === undefined) return [];
    const categories = contextMap.categoryTokens;
    if (categories) {
      return [
        { kind: "retained", pct: (categories.retained / total) * 100 },
        { kind: "candidate", pct: (categories.candidate / total) * 100 },
        { kind: "protected", pct: (categories.protected / total) * 100 },
        { kind: "compressed", pct: (categories.compressed / total) * 100 },
      ];
    }
    return [{ kind: "occupied", pct: ((contextMap.occupiedTokens ?? 0) / total) * 100 }];
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

  function limitTitle(label: "H" | "W" | "R", window: ModelUsageLimitWindow): string {
    const name = modelUsageWindowLabel(label, window);
    const weeklySlices = label === "W"
      ? ` · day slices ${weeklyDayLabels(window).join(" · ")} (aggregate quota, not per-day usage)`
      : "";
    // Header windows without a known reset carry no honest countdown.
    const reset = label === "R" && window.resetAt <= now
      ? ""
      : ` · resets ${formatResetDuration(window.resetAt, now)}`;
    const cached = modelUsage?.stale ? "Cached quota · " : "";
    return `${cached}${name} limit · ${Math.round(window.remainingPercent)}% remaining${reset}${weeklySlices}`;
  }

  function usageWindows(): Array<{ key: string; label: "H" | "W" | "R"; window: ModelUsageLimitWindow }> {
    const windows: Array<{ key: string; label: "H" | "W" | "R"; window: ModelUsageLimitWindow }> = [];
    if (modelUsage?.hourly) windows.push({ key: "H", label: "H", window: modelUsage.hourly });
    if (modelUsage?.weekly) windows.push({ key: "W", label: "W", window: modelUsage.weekly });
    // Header-derived rate limits collapse into the single most-limiting
    // short window so the status bar stays one compact indicator.
    const rate = limitingRateWindow(modelUsage);
    if (rate) windows.push({ key: "R", label: "R", window: rate });
    return windows;
  }

</script>

{#snippet contextScale()}
  <span
    class="flex h-1.5 w-16 overflow-hidden rounded-sm bg-border"
    data-context-scale="compact"
    aria-hidden="true"
  >
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
{/snippet}

{#snippet contextRing()}
  {@const segments = ringSegments().filter((segment) => segment.pct > 0)}
  {@const occupiedPct = segments.reduce((sum, segment) => sum + segment.pct, 0)}
  {@const sectors = [...segments, { kind: "free", pct: Math.max(0, 100 - occupiedPct) }].filter((segment) => segment.pct > 0)}
  <div class="relative h-[88px] w-[88px] shrink-0" data-context-ring aria-hidden="true">
    <svg viewBox="0 0 36 36" class="h-[88px] w-[88px] -rotate-90">
      <circle cx="18" cy="18" r="15.915" fill="none" class="stroke-border" stroke-width="3.5"></circle>
      {#each segments as segment, index}
        {@const offset = segments.slice(0, index).reduce((sum, s) => sum + s.pct, 0)}
        <circle
          cx="18" cy="18" r="15.915" fill="none"
          class={contextStrokeClass(segment.kind)}
          stroke-width="3.5"
          stroke-dasharray={`${segment.pct} ${100 - segment.pct}`}
          stroke-dashoffset={-offset}
        ></circle>
      {/each}
      {#if sectors.length > 1}
        {#each sectors as _, index}
          {@const offset = sectors.slice(0, index).reduce((sum, s) => sum + s.pct, 0)}
          <line
            x1={18 + 15.915 - 1.75} y1="18"
            x2={18 + 15.915 + 1.75} y2="18"
            transform={`rotate(${offset / 100 * 360} 18 18)`}
            stroke="var(--popover)" stroke-width="0.5"
            data-context-separator
          ></line>
        {/each}
      {/if}
    </svg>
    <div class="absolute inset-0 grid place-items-center">
      <span class={["font-mono text-sm font-semibold", contextTone ? toneTextClass(contextTone) : "text-foreground"]}>
        {contextPercent === null || contextPercent === undefined ? "?%" : `${Math.round(contextPercent)}%`}
      </span>
    </div>
  </div>
{/snippet}

{#snippet contextScaleLegend()}
  <div class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground" aria-label="Context color legend">
    {#each contextLegend as item}
      <span class="inline-flex items-center justify-between gap-2">
        <span class="inline-flex min-w-0 items-center gap-1">
          <i class={["h-2 w-2 shrink-0 rounded-[1px]", contextCellClass(item.kind)]} aria-hidden="true"></i>
          <span class="truncate">{item.label}</span>
        </span>
        {#if item.value}<span class="shrink-0 tabular-nums">{item.value}</span>{/if}
      </span>
    {/each}
  </div>
{/snippet}

<svelte:window onpointerdown={closeOutside} onkeydown={handleKeydown} />

{#snippet retryIndicator()}
  {#if quotaWaitIndicator}
    <button
      class="relative z-10 flex h-6 w-2.5 shrink-0 items-center justify-center rounded-sm text-tool-warning hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      type="button"
      aria-label={quotaWaitIndicator.label}
      data-quota-wait-indicator
      onclick={() => quotaWaitIndicator?.onReopen()}
    >
      <RotateCw class="h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  {/if}
{/snippet}

{#if status || showSkeletons || quotaWaitIndicator}
  <div
    bind:this={root}
    class="runtime-status-layout grid min-w-0 items-center gap-3"
    data-runtime-status
  >
    {#if status?.context || status?.dcpTokensSaved !== undefined}
      <div class="relative min-w-0" data-runtime-context role="group" aria-label="Context"
        data-context-region
        onfocusout={(event) => leaveDetails(event, "context")}
      >
        <button
          class="context-status-slots grid h-6 w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring text-left"
          class:with-savings={showSavings}
          type="button"
          aria-label={contextTitle()}
          aria-haspopup="dialog"
          aria-expanded={contextOpen}
          aria-controls="runtime-context-popover"
          onclick={toggleContext}
        >
          <span class="font-sans text-xs text-muted-foreground">ctx</span>
          <span class={["truncate text-right", contextTone ? toneTextClass(contextTone) : "text-muted-foreground"]}>{contextPercent === null || contextPercent === undefined ? "?%" : `${Math.round(contextPercent)}%`}</span>
          {@render contextScale()}
          {#if showSavings && status?.dcpTokensSaved !== undefined}
            <span class="truncate text-muted-foreground">saved {savedTokensFormatter.format(status.dcpTokensSaved)}</span>
          {/if}
        </button>

        {#if contextOpen}
          <div
            id="runtime-context-popover"
            class="absolute bottom-full left-0 z-50 max-h-[max(0px,calc(100dvh-70px))] w-max max-w-[min(360px,calc(100vw-16px))] overflow-y-auto overscroll-contain"
            role="dialog"
            aria-label="Context usage details"
            tabindex="0"
          >
            <div class="w-72 rounded-md border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-md">
              <div class="font-mono text-xs text-muted-foreground">{contextTitle(false)}</div>
              {#if status?.dcpTokensSaved !== undefined}
                <div class="mt-2 flex items-center justify-between gap-3 rounded-md border border-tool-success/30 bg-tool-success/10 px-2.5 py-1.5">
                  <span class="text-xs text-tool-success">DCP saved you</span>
                  <span class="font-mono text-xs font-semibold text-tool-success">~{savedTokensFormatter.format(status.dcpTokensSaved)} tokens</span>
                </div>
              {/if}
              <div class="mt-2.5 flex items-center gap-3">
                {@render contextRing()}
                {@render contextScaleLegend()}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div
        class="context-status-slots grid h-6 min-w-0 items-center gap-1.5 overflow-hidden px-1.5 font-mono text-xs"
        class:invisible={!showSkeletons}
        data-runtime-context-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground">ctx</span>
        <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-1.5 w-16 rounded-sm bg-border"></span>
      </div>
    {/if}

    {#if sessionUsageAvailable || status?.modelUsage || status?.headerUsage || quotaWaitIndicator}
      <div class="relative min-w-0" role="group" aria-label="Usage"
        data-usage-region
        onfocusout={(event) => leaveDetails(event, "usage")}
      >
        <div class="usage-status-slots grid relative h-6 w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 font-mono text-xs tabular-nums text-left">
        <!-- Separate sibling controls: retry must not nest inside the Usage button. -->
        <button
          class="absolute inset-0 rounded-sm hover:bg-chrome-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          type="button"
          aria-label="Session usage and cost"
          aria-haspopup="dialog"
          aria-expanded={usageOpen}
          aria-controls="runtime-usage-popover"
          onclick={toggleUsage}
        ></button>
          <span class="pointer-events-none relative font-sans text-xs text-muted-foreground">Usage</span>
          {#each usageWindowItems as { key, label, window } (key)}
              {@const tone = modelUsageTone(window.remainingPercent)}
              {@const exhaustsEarly = modelUsageWindowWillExhaustBeforeReset(window, now)}
              <span class="quota-status-slots grid items-center gap-1" class:quota-short-track={label !== "W"} aria-label={limitTitle(label, window)}>
                <span class="quota-values pointer-events-none relative col-span-3 grid items-center">
                  <span class={["whitespace-nowrap text-right", toneTextClass(tone)]}>{Math.round(window.remainingPercent)}%</span>
                <span class="flex h-6 flex-col justify-center gap-0.5 overflow-hidden">
                {#if label === "R"}
                  <span class="truncate leading-3 text-muted-foreground">{modelUsageWindowLabel(label, window)}</span>
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
                </span>
                <span class="truncate text-muted-foreground">{label !== "R" || window.resetAt > now ? formatResetDuration(window.resetAt, now) : ""}</span>
                </span>
                <span class="relative flex w-2.5 items-center">
                  {#if quotaWaitIndicator && key === usageWindowItems[0]?.key}
                    {@render retryIndicator()}
                  {:else if exhaustsEarly}
                    <TriangleAlert class="h-2.5 w-2.5 text-tool-warning" aria-label="Projected to exhaust before reset" />
                  {:else if modelUsage?.stale}
                    <Hourglass class="h-2.5 w-2.5 text-muted-foreground" aria-label="Cached quota from the last successful refresh" />
                  {/if}
                </span>
              </span>
          {/each}
          {#if quotaWaitIndicator && usageWindowItems.length === 0}
            {@render retryIndicator()}
          {/if}
        </div>

        {#if usageOpen}
          <div
            id="runtime-usage-popover"
            class="absolute right-0 bottom-full z-50 w-[min(360px,calc(100vw-16px))]"
            role="dialog"
            aria-label="Session usage and cost"
          >
            <div class="flex max-h-[max(0px,calc(100dvh-70px))] flex-col overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
              <header class="shrink-0 border-b border-border px-3 py-2">
                <div class="text-xs font-medium text-foreground">Session usage</div>
                {#if usageAccountLabel}
                  <div class="truncate text-xs text-muted-foreground">{usageAccountLabel}</div>
                {/if}
                {#if modelUsage?.stale}
                  <div class="text-xs text-muted-foreground">Cached quota from the last successful refresh; windows expire at their own reset.</div>
                {/if}
                {#if !sessionUsage}
                  <div class="mt-0.5 font-mono text-xs text-muted-foreground">
                    {#if loadingSessionUsage}
                      Loading recorded usage…
                    {:else if sessionUsageFailed}
                      Could not load recorded usage.
                    {:else if sessionUsageAvailable}
                      Loading recorded usage…
                    {:else}
                      Session runtime is still loading.
                    {/if}
                  </div>
                {/if}
              </header>
              <div class="min-h-0 overflow-y-auto overscroll-contain px-3 py-2.5 text-xs">
                <UsageLimitBars windows={popupLimitWindows} {now} stale={modelUsage?.stale === true} />
                {#if modelUsage?.weekly}
                  <QuotaResetCalendar window={modelUsage.weekly} {now} stale={modelUsage.stale === true} />
                {/if}
                {#if modelUsage?.resetCredits?.length || modelUsage?.resetCreditsAvailableCount}
                  <ResetCreditsSection credits={modelUsage.resetCredits ?? []} availableCount={modelUsage.resetCreditsAvailableCount} {now} />
                {/if}
                <ModelUsageDonut models={donutModels} />
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
                      <div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 font-mono tabular-nums">
                        <span class="col-span-3 grid grid-cols-subgrid pb-1 text-xs font-sans tracking-wide text-muted-foreground/70">
                          <span></span>
                          <span class="text-right uppercase">Tokens</span>
                          <span class="text-right uppercase">Cost</span>
                        </span>
                        {#each sessionUsage.providers as provider (provider.provider)}
                          {@const usageUrl = providerUsageUrl(provider.provider)}
                          <div class="col-span-3 mt-1 flex min-w-0 items-center gap-1.5 text-xs font-sans font-medium text-muted-foreground first:mt-0">
                            {#if modelProviderBrand(provider.provider)}
                              <ModelProviderIcon provider={provider.provider} />
                            {/if}
                            <span class="min-w-0 truncate">{provider.provider}</span>
                            {#if usageUrl}
                              <button
                                type="button"
                                class="grid h-5 w-5 shrink-0 place-items-center rounded-sm hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                aria-label={`Open ${provider.provider} usage limits in browser`}
                                onclick={() => void openProviderUsage(usageUrl)}
                              ><ExternalLink class="h-3 w-3" aria-hidden="true" /></button>
                            {/if}
                          </div>
                          {#each provider.models as model (`${provider.provider}/${model.model}`)}
                            <span
                              class={["min-w-0 truncate font-medium", modelDisplayToneClass(modelRefTone(`${provider.provider}/${model.model}`))]}
                              aria-label={`${provider.provider}/${model.model}`}
                            >{model.model}</span>
                            <span class="text-right text-foreground">{formatSessionUsageTokens(model.totals.totalTokens)}</span>
                            <span class="text-right text-foreground" aria-label={model.totals.costEstimated ? "Estimated at original model API rates, not subscription charges" : undefined}>{formatSessionUsageCost(model.totals.cost)}</span>
                          {/each}
                        {/each}
                        {#if sessionUsageHasValue(sessionUsage.unattributed)}
                          <span class="truncate text-muted-foreground">Unattributed</span>
                          <span class="text-right text-muted-foreground">{formatSessionUsageTokens(sessionUsage.unattributed.totalTokens)}</span>
                          <span class="text-right text-muted-foreground">{formatSessionUsageCost(sessionUsage.unattributed.cost)}</span>
                        {/if}
                        <span class="col-span-3 mt-1 border-t border-border"></span>
                        <span class="font-sans font-semibold text-foreground">Total</span>
                        <span class="text-right font-semibold text-foreground">{formatSessionUsageTokens(sessionUsage.totals.totalTokens)}</span>
                        <span class="text-right font-semibold text-foreground">{formatSessionUsageCost(sessionUsage.totals.cost)}</span>
                      </div>
                    {/if}
                  </section>
                {/if}
              </div>
              {#if usageLinkFailed}
                <p class="px-3 pb-2 text-xs text-destructive" role="alert">Could not open provider usage page. Try again.</p>
              {/if}
              {#if claudeCodeRoute && sessionUsageAvailable}
                <div class="border-t border-border px-3 py-2 text-xs">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-muted-foreground">Claude Code limits</span>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={claudeLimitsRefreshing}
                      onclick={onRefreshClaudeLimits}
                      aria-label="Refresh Claude Code limits"
                    >
                      {#if claudeLimitsRefreshing}
                        <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
                      {:else}
                        <RefreshCw class="h-3 w-3" aria-hidden="true" />
                      {/if}
                      <span role="status" aria-live="polite">{claudeLimitsRefreshing ? "Refreshing…" : "Refresh limits"}</span>
                    </button>
                  </div>
                  {#if claudeLimitsFailed}
                    <p class="mt-1 text-tool-warning" role="status">Could not refresh Claude Code limits. Retry or check your Claude Code login.</p>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div
        class="usage-status-slots grid h-6 min-w-0 items-center gap-1.5 overflow-hidden px-1.5 font-mono text-xs"
        class:invisible={!showSkeletons}
        data-runtime-usage-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground">Usage</span>
          <span class="quota-status-slots grid items-center gap-1">
            <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
            <span class="h-1.5 w-14 rounded-sm bg-border"></span>
            <span class="h-3 w-12 rounded-sm bg-muted-foreground/15"></span>
            <span></span>
          </span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .runtime-status-layout {
    /* Fit visible windows, not hypothetical quotas. Values retain fixed inner slots. */
    width: max-content;
    max-width: 100%;
    flex: 0 1 auto;
    grid-template-columns: minmax(0, max-content) minmax(0, max-content);
  }

  .context-status-slots {
    grid-template-columns: 3ch 4ch 64px;
    column-gap: 6px;
  }

  .context-status-slots.with-savings {
    /* Reserve a bounded estimate only when there are actual savings. */
    grid-template-columns: 3ch 4ch 64px 11ch;
  }

  .usage-status-slots {
    grid-template-columns: 36px;
    column-gap: 8px;
    grid-auto-columns: max-content;
    grid-auto-flow: column;
  }

  .quota-status-slots {
    /* Leave a full glyph of slack: exact 4ch tracks can ellipsize 100% in WebKit. */
    grid-template-columns: 5ch 56px 5ch 10px;
    column-gap: 6px;
  }

  .quota-short-track {
    grid-template-columns: 5ch 32px 5ch 10px;
  }

  .quota-values {
    grid-template-columns: subgrid;
  }
</style>
