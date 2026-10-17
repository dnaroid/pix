<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { onMount, setContext, untrack } from "svelte";
  import type { AcpClient, RuntimeStatus } from "../../lib/acp-client";
  import { createUsagePanelSections } from "../../app/usage-panel-sections.svelte";
  import { USAGE_SECTIONS_CONTEXT } from "../../lib/usage-panel-sections";
  import { createUsageStatsStore } from "../../app/usage-stats.svelte";
  import { createProviderUsageStore } from "../../app/provider-usage.svelte";
  import { createDiagnosticLogger } from "../../lib/diagnostic-logging";
  import { iconButtonClass } from "../../lib/icon-button";
  import { subscribeUsageStatsChanged } from "../../lib/usage-stats-events";
  import { hasUsageData, type UsagePeriod, type UsageSessionTarget } from "../../lib/usage-stats";
  import UsageSegmented from "./UsageSegmented.svelte";
  import UsageSourceView from "./UsageSourceView.svelte";
  import UsageProviderLimits from "./UsageProviderLimits.svelte";
  import { PERIOD_LABELS, STATUS_LABELS } from "./usage-format";

  let { client, workspace, providerStatuses = [], onOpenSession }: {
    client: AcpClient | null;
    workspace: string;
    providerStatuses?: readonly RuntimeStatus[];
    onOpenSession?: (target: UsageSessionTarget) => void;
  } = $props();

  const PERIODS: readonly UsagePeriod[] = ["7d", "30d", "90d", "all"];
  let error = $state<string | null>(null);
  let period = $state<UsagePeriod>("7d");

  const diagnostics = createDiagnosticLogger(() => ({ workspace }));
  const sections = createUsagePanelSections((cause, target) => {
    if (target === workspace) error = cause instanceof Error ? cause.message : String(cause);
    createDiagnosticLogger(() => ({ workspace: target })).report(cause, "frontend:usage-panel-state");
  });
  setContext(USAGE_SECTIONS_CONTEXT, sections);
  $effect(() => {
    const target = workspace;
    untrack(() => { void sections.load(target); });
  });
  const store = createUsageStatsStore({
    client: () => client,
    workspace: () => workspace,
    reportError: (cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
      diagnostics.report(cause);
    },
  });
  const quotas = createProviderUsageStore({
    client: () => client,
    workspace: () => workspace,
    reportError: (cause) => diagnostics.report(cause, "frontend:provider-usage"),
  });
  const quotaStatuses = $derived([...providerStatuses, ...quotas.entries.flatMap((entry) => entry.runtime ? [entry.runtime] : [])]);
  const refreshing = $derived(store.busy || quotas.busy);

  // Re-read the clock whenever data changes; no timers while the panel idles.
  const nowMs = $derived.by(() => { void store.snapshots; return Date.now(); });
  const snapshot = $derived(store.snapshot("pix-sessions"));
  const hasData = $derived(hasUsageData(snapshot));

  // Panel mounted = open. Scope (client/workspace) changes re-request in place.
  $effect(() => {
    void client;
    void workspace;
    untrack(() => {
      error = null;
      void (store.active ? store.sync() : store.open());
      void quotas.refresh();
    });
  });

  onMount(() => {
    const unsubscribe = subscribeUsageStatsChanged((notification) => store.handleChanged(notification));
    return () => {
      unsubscribe();
      store.dispose();
      quotas.dispose();
      sections.dispose();
    };
  });

  function refresh(): void {
    error = null;
    void store.refresh();
    void quotas.refresh();
  }
</script>

<section class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel" aria-label="Usage statistics">
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-sidebar-border pr-1 pl-2">
    <h2 class="m-0 min-w-0 flex-1 truncate text-xs font-medium text-foreground">Pix usage</h2>
    <button
      class={iconButtonClass("sm", "panel")}
      type="button" title="Refresh usage" aria-label="Refresh usage"
      disabled={!client || !workspace || refreshing}
      aria-busy={refreshing}
      onclick={refresh}
    ><RefreshCw class={["h-3.5 w-3.5", refreshing && "animate-spin motion-reduce:animate-none"]} aria-hidden="true" /></button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col overflow-auto">
    {#if error}
      <div class="flex items-start gap-2 border-b border-sidebar-border border-l-2 border-l-tool-error px-3 py-1.5 text-xs text-tool-error" role="alert">
        <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span class="min-w-0 break-words">{error}</span>
      </div>
    {/if}
    {#if !client}
      <p class="m-0 px-3 py-6 text-center text-xs text-muted-foreground">Connect to Pix to load usage statistics.</p>
    {:else if !workspace}
      <p class="m-0 px-3 py-6 text-center text-xs text-muted-foreground">Open a project to load usage statistics.</p>
    {:else}
      <UsageProviderLimits statuses={quotaStatuses} entries={quotas.entries} loading={quotas.busy} failed={quotas.error} />
      <div class="flex flex-wrap items-center gap-1.5 px-3 pt-2">
        <UsageSegmented value={period} options={PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))} ariaLabel="Period" onChange={(value) => period = value} />
      </div>
      {#if snapshot && hasData}
        {#key snapshot.source}
          <UsageSourceView {snapshot} {period} {nowMs} {workspace} {...(onOpenSession ? { onOpenSession } : {})} />
        {/key}
      {:else if snapshot && snapshot.status !== "loading"}
        <div class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">
          <p class="m-0 font-medium text-foreground">{snapshot.status === "ready" || snapshot.status === "stale" ? "No usage recorded yet" : STATUS_LABELS[snapshot.status]}</p>
          {#if snapshot.message}<p class="m-0 mt-1 leading-4">{snapshot.message}</p>{/if}
        </div>
      {:else}
        <p class="m-0 px-3 py-6 text-center text-xs text-muted-foreground" role="status">Loading usage…</p>
      {/if}
    {/if}
  </div>
</section>
