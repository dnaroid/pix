<script lang="ts">
  import { onMount } from "svelte";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
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
  import QuotaResetCalendar from "./QuotaResetCalendar.svelte";
  import ResetCreditsSection from "./ResetCreditsSection.svelte";

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
  const contextPercent = $derived(status?.context?.percent);
  const contextTone = $derived(contextPercent === null || contextPercent === undefined ? undefined : contextUsageTone(contextPercent));
  const contextMap = $derived(dcpContextMap(status?.context, parseDcpContextMap(status?.dcpContextMap)));
  const contextLegend = $derived(contextLegendItems());
  // Quota usage wins while the provider quota is the freshest observation;
  // an API-key header snapshot pushed after a mid-session auth switch (or a
  // quota left over from a previous model) must not stay hidden behind it.
  const modelUsage = $derived(displayModelUsage(status, now));
  const usageAccountLabel = $derived(shortModelUsageAccountLabel(modelUsage?.accountEmail));
  const usageWindowItems = $derived(usageWindows());

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

  function contextTitle(): string {
    const context = status?.context;
    const saved = status?.dcpTokensSaved;
    const savings = saved === undefined
      ? ""
      : ` · DCP saved ~${Math.round(saved).toLocaleString("en-US")} tokens`;
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
    return `${name} limit · ${Math.round(window.remainingPercent)}% remaining${reset}${weeklySlices}`;
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

{#snippet contextScale(size: "compact" | "expanded")}
  <span
    class={size === "compact"
      ? "flex h-1.5 w-16 overflow-hidden rounded-sm bg-border"
      : "flex h-4 w-full overflow-hidden rounded-sm bg-border"}
    data-context-scale={size}
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

{#snippet contextScaleLegend()}
  <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Context color legend">
    {#each contextLegend as item}
      <span class="inline-flex items-center gap-1">
        <i class={["h-2 w-2 shrink-0 rounded-[1px]", contextCellClass(item.kind)]} aria-hidden="true"></i>
        <span>{item.label}{item.value ? ` ${item.value}` : ""}</span>
      </span>
    {/each}
  </div>
{/snippet}

<svelte:window onpointerdown={closeOutside} onkeydown={handleKeydown} />

{#if status || showSkeletons}
  <div
    bind:this={root}
    class="@container/runtime-status flex min-w-0 flex-1 items-center justify-between gap-1"
    data-runtime-status
  >
    {#if status?.context || status?.dcpTokensSaved !== undefined}
      <div class="relative min-w-0" data-runtime-context role="group" aria-label="Context"
        data-context-region
        onfocusout={(event) => leaveDetails(event, "context")}
      >
        <button
          class="flex h-6 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&>span]:shrink-0"
          type="button"
          aria-label={contextTitle()}
          aria-haspopup="dialog"
          aria-expanded={contextOpen}
          aria-controls="runtime-context-popover"
          onclick={toggleContext}
        >
          <span class="font-sans text-xs text-muted-foreground">ctx</span>
          <span class={contextTone ? toneTextClass(contextTone) : "text-muted-foreground"}>{contextPercent === null || contextPercent === undefined ? "?%" : `${Math.round(contextPercent)}%`}</span>
          {@render contextScale("compact")}
          {#if status?.dcpTokensSaved !== undefined}
            <span class="text-muted-foreground">saved ~{formatCompactTokens(status.dcpTokensSaved)}</span>
          {/if}
        </button>

        {#if contextOpen}
          <div
            id="runtime-context-popover"
            class="absolute bottom-full left-0 z-50 w-max max-w-[min(360px,calc(100vw-16px))]"
            role="dialog"
            aria-label="Context usage details"
            tabindex="0"
          >
            <div class="rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md">
              <div class="font-mono text-xs text-muted-foreground">{contextTitle()}</div>
              <div class="mt-2">{@render contextScale("expanded")}</div>
              {@render contextScaleLegend()}
            </div>
          </div>
        {/if}
      </div>
    {:else if showSkeletons}
      <div
        class="flex h-6 min-w-0 items-center gap-1.5 overflow-hidden px-1.5 [&>span]:shrink-0"
        data-runtime-context-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground">ctx</span>
        <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-1.5 w-16 rounded-sm bg-border"></span>
        <span class="h-3 w-14 rounded-sm bg-muted-foreground/15"></span>
      </div>
    {/if}

    {#if sessionUsageAvailable || status?.modelUsage || status?.headerUsage}
      <div class="relative ml-auto min-w-0 shrink-0 max-w-full" role="group" aria-label="Usage"
        data-usage-region
        onfocusout={(event) => leaveDetails(event, "usage")}
      >
        <button
          class="flex h-6 min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&>span]:shrink-0"
          type="button"
          aria-label="Session usage and cost"
          aria-haspopup="dialog"
          aria-expanded={usageOpen}
          aria-controls="runtime-usage-popover"
          onclick={toggleUsage}
        >
          <span class="font-sans text-xs text-muted-foreground @max-[380px]/runtime-status:hidden">Usage</span>
          {#if usageAccountLabel}
            <span class="max-w-28 truncate text-muted-foreground @max-[600px]/runtime-status:hidden">{usageAccountLabel}</span>
          {/if}
          {#if modelUsage?.stale}
            <span
              class="flex items-center gap-0.5 text-muted-foreground"
              aria-label="Cached quota from the last successful refresh; each window stays visible only until its own reset"
            >
              <Hourglass class="h-2.5 w-2.5" aria-hidden="true" />
              <span>stale</span>
            </span>
          {/if}
          {#each usageWindowItems as { key, label, window } (key)}
              {@const tone = modelUsageTone(window.remainingPercent)}
              {@const exhaustsEarly = modelUsageWindowWillExhaustBeforeReset(window, now)}
              <span class="flex items-center gap-1" aria-label={limitTitle(label, window)}>
                {#if label === "R"}
                  <span class="text-muted-foreground">{modelUsageWindowLabel(label, window)}</span>
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
                {#if label !== "R" || window.resetAt > now}
                  <span class="text-muted-foreground @max-[480px]/runtime-status:hidden">{formatResetDuration(window.resetAt, now)}</span>
                {/if}
              </span>
          {/each}
        </button>

        {#if usageOpen}
          <div
            id="runtime-usage-popover"
            class="absolute right-0 bottom-full z-50 w-[min(360px,calc(100vw-16px))]"
            role="dialog"
            aria-label="Session usage and cost"
          >
            <div class="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
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
              <div class="max-h-[min(640px,calc(100vh-120px))] overflow-y-auto px-3 py-2.5 text-xs">
                {#if modelUsage?.weekly}
                  <QuotaResetCalendar window={modelUsage.weekly} {now} stale={modelUsage.stale === true} />
                {/if}
                {#if modelUsage?.resetCredits?.length || modelUsage?.resetCreditsAvailableCount}
                  <ResetCreditsSection credits={modelUsage.resetCredits ?? []} availableCount={modelUsage.resetCreditsAvailableCount} {now} />
                {/if}
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
                        {@const usageUrl = providerUsageUrl(provider.provider)}
                        <div>
                          <div class="mb-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
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
                          <div class="space-y-1">
                            {#each provider.models as model (`${provider.provider}/${model.model}`)}
                              <div class="flex min-w-0 items-center justify-between gap-3 font-mono tabular-nums">
                                <span
                                  class={["min-w-0 truncate font-medium", modelDisplayToneClass(modelRefTone(`${provider.provider}/${model.model}`))]}
                                  aria-label={`${provider.provider}/${model.model}`}
                                >{model.model}</span>
                                <span class="shrink-0 text-foreground" aria-label={model.totals.costEstimated ? "Estimated at original model API rates, not subscription charges" : undefined}>{formatSessionUsageTokens(model.totals.totalTokens)} · {formatSessionUsageCost(model.totals.cost)}</span>
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
                      {claudeLimitsRefreshing ? "Refreshing…" : "Refresh limits"}
                    </button>
                  </div>
                  {#if claudeLimitsFailed}
                    <p class="mt-1 text-tool-warning" role="status">Could not refresh Claude Code limits. Retry or check your Claude Code login.</p>
                  {:else if claudeLimitsRefreshing}
                    <p class="mt-1 text-muted-foreground" role="status">Checking Claude Code login and limits…</p>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else if showSkeletons}
      <div
        class="ml-auto flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 overflow-hidden px-1.5 font-mono text-xs [&>span]:shrink-0"
        data-runtime-usage-skeleton
        aria-hidden="true"
      >
        <span class="font-sans text-xs text-muted-foreground @max-[380px]/runtime-status:hidden">Usage</span>
        <span class="h-1.5 w-8 rounded-sm bg-border"></span>
        <span class="h-3 w-6 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-3 w-16 rounded-sm bg-muted-foreground/15 @max-[480px]/runtime-status:hidden"></span>
      </div>
    {/if}
  </div>
{/if}
