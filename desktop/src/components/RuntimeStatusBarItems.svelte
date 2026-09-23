<script lang="ts">
  import { onMount } from "svelte";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Minimize2 from "@lucide/svelte/icons/minimize-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ModelUsageLimitWindow, RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
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
    workspacePath,
    workspaceName,
    workspaceBranch,
    workspaceHue,
    workspaceColor,
    loadingDcpStats = false,
    sessionUsage,
    loadingSessionUsage = false,
    sessionUsageAvailable = false,
    compressingContext = false,
    compressionAvailable = true,
    canCompressContext = true,
    onOpenSessionUsage,
    onOpenDcpStats,
    onCompressContext,
  }: {
    status?: RuntimeStatus;
    workspacePath?: string;
    workspaceName?: string;
    workspaceBranch?: string;
    workspaceHue?: number;
    workspaceColor?: string;
    loadingDcpStats?: boolean;
    sessionUsage?: SessionUsageReport;
    loadingSessionUsage?: boolean;
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
  const contextPercent = $derived(status?.context?.percent);
  const contextTone = $derived(contextPercent === null || contextPercent === undefined ? undefined : contextUsageTone(contextPercent));
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
    return "text-tool-success";
  }

  function toneFillClass(tone: UsageTone): string {
    if (tone === "error") return "bg-tool-error";
    if (tone === "warning") return "bg-tool-warning";
    return "bg-tool-success";
  }

  function limitTitle(label: "H" | "W", window: ModelUsageLimitWindow): string {
    const name = label === "H" ? "Hourly" : "Weekly";
    return `${name} limit · ${Math.round(window.remainingPercent)}% remaining · resets ${formatResetDuration(window.resetAt, now)}`;
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

{#if status || workspaceName}
  <div bind:this={root} class="flex min-w-0 items-center gap-1" data-runtime-status>
    {#if status?.context || status?.dcpTokensSaved !== undefined}
      <div class="relative shrink-0">
        <button
          class="flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 font-mono text-xs tabular-nums hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          type="button"
          title={contextTitle()}
          aria-label={contextTitle()}
          aria-haspopup="dialog"
          aria-expanded={dcpOpen}
          aria-controls="runtime-dcp-popover"
          onclick={toggleDcp}
        >
          <span class="font-sans text-xs text-muted-foreground max-[860px]:hidden">Context</span>
          <span class={contextTone ? toneTextClass(contextTone) : "text-muted-foreground"}>{contextPercent === null || contextPercent === undefined ? "?%" : `${Math.round(contextPercent)}%`}</span>
          <span class="relative h-1.5 w-10 overflow-hidden rounded-sm bg-border" aria-hidden="true">
            {#if contextTone && contextPercent !== null && contextPercent !== undefined}
              <span
                class={["absolute inset-y-0 left-0 rounded-sm", toneFillClass(contextTone)]}
                style={`width: ${clampUsagePercent(contextPercent)}%`}
              ></span>
            {/if}
          </span>
        </button>

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
    {/if}

    {#if workspaceName}
      <div
        class="flex min-w-0 max-w-[260px] items-center gap-1 px-1.5 font-mono text-xs"
        title={workspacePath ?? workspaceName}
        data-runtime-workspace
      >
        <span
          class="runtime-workspace-name min-w-0 truncate"
          style:--runtime-workspace-hue={workspaceHue}
          style:--runtime-workspace-color={workspaceColor}
        >{workspaceName}</span>
        {#if workspaceBranch}
          <span class="max-w-36 shrink truncate text-muted-foreground">({workspaceBranch})</span>
        {/if}
      </div>
    {/if}

    {#if sessionUsageAvailable || status?.modelUsage}
      <div class="relative shrink-0">
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
                <span class="relative h-1.5 w-8 overflow-hidden rounded-sm bg-border" aria-hidden="true">
                  <span
                    class={["absolute inset-y-0 left-0 rounded-sm", toneFillClass(tone)]}
                    style={`width: ${clampUsagePercent(window.remainingPercent)}%`}
                  ></span>
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
                {:else if sessionUsageAvailable}
                  Usage has not been loaded yet.
                {:else}
                  No live session yet.
                {/if}
              </div>
            </header>
            <div class="max-h-[min(460px,60vh)] overflow-y-auto px-3 py-2.5 text-xs">
              {#if loadingSessionUsage && !sessionUsage}
                <div class="flex items-center gap-1.5 text-muted-foreground" aria-live="polite">
                  <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span>Loading session usage…</span>
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
    {/if}
  </div>
{/if}

<style>
  .runtime-workspace-name {
    color: var(--runtime-workspace-color, oklch(0.62 0.15 var(--runtime-workspace-hue)));
  }

  @media (prefers-color-scheme: dark) {
    .runtime-workspace-name {
      color: var(--runtime-workspace-color, oklch(0.74 0.13 var(--runtime-workspace-hue)));
    }
  }
</style>
