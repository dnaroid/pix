<script module lang="ts">
  export interface UsagePanelHandle {
    refresh(): void;
    refreshState(): { busy: boolean; disabled: boolean };
  }
</script>

<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { onMount, setContext, untrack } from "svelte";
  import type { AcpClient, RuntimeStatus } from "../../lib/acp-client";
  import { createUsagePanelSections } from "../../app/usage-panel-sections.svelte";
  import { USAGE_SECTIONS_CONTEXT, USAGE_SECTION_IDS } from "../../lib/usage-panel-sections";
  import { createUsageStatsStore } from "../../app/usage-stats.svelte";
  import { createProviderUsageStore } from "../../app/provider-usage.svelte";
  import { createOpenRouterUsageStore } from "../../app/openrouter-usage.svelte";
  import { createDiagnosticLogger } from "../../lib/diagnostic-logging";
  import { providerUsageOrder } from "../../lib/provider-usage-rows";
  import { subscribeUsageStatsChanged } from "../../lib/usage-stats-events";
  import type { UsagePeriod, UsageSessionTarget } from "../../lib/usage-stats";
  import UsageSegmented from "./UsageSegmented.svelte";
  import UsageSourceView from "./UsageSourceView.svelte";
  import UsageProviderLimits from "./UsageProviderLimits.svelte";
  import { PERIOD_LABELS } from "./usage-format";

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
    createDiagnosticLogger(() => ({ workspace: target })).warn("frontend:usage-panel-state", cause);
  });
  setContext(USAGE_SECTIONS_CONTEXT, sections);
  $effect(() => {
    const target = workspace;
    untrack(() => { error = null; void sections.load(target); });
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
    reportError: (cause) => diagnostics.warn("frontend:provider-usage", cause),
  });
  const openRouter = createOpenRouterUsageStore({
    reportError: (cause) => diagnostics.warn("frontend:openrouter-usage", cause),
  });
  const providerOpen = $derived(sections.ready && sections.isOpen("provider-limits"));
  const historyOpen = $derived(sections.ready && USAGE_SECTION_IDS.some((id) => id !== "provider-limits" && sections.isOpen(id)));
  const statisticsOpen = $derived(historyOpen || providerOpen);
  const quotaStatuses = $derived(providerOpen ? [...providerStatuses, ...quotas.entries.flatMap((entry) => entry.runtime ? [entry.runtime] : [])] : []);
  const refreshing = $derived(store.busy || quotas.busy || openRouter.busy);

  // Re-read the clock whenever data changes; no timers while the panel idles.
  const nowMs = $derived.by(() => { void store.snapshots; return Date.now(); });
  const snapshot = $derived(store.snapshot("pix-sessions"));

  // Limits also consume the shared source for popularity, without mounting historical charts.
  $effect(() => {
    void client;
    void workspace;
    const active = statisticsOpen;
    untrack(() => {
      if (active) void (store.active ? store.sync() : store.open());
      else store.close();
    });
  });
  $effect(() => {
    void client;
    void workspace;
    const active = providerOpen;
    untrack(() => {
      if (active) void quotas.resume();
      else quotas.pause();
      if (active) void openRouter.resume();
      else openRouter.pause();
    });
  });
  $effect(() => {
    const current = providerOpen ? snapshot : undefined;
    if (!current) return;
    untrack(() => { void sections.setProviderOrder(providerUsageOrder(current, sections.providerOrder)); });
  });

  onMount(() => {
    const unsubscribe = subscribeUsageStatsChanged((notification) => store.handleChanged(notification));
    return () => {
      unsubscribe();
      store.dispose();
      quotas.dispose();
      openRouter.dispose();
      sections.dispose();
    };
  });

  export function refresh(): void {
    error = null;
    void store.refresh();
    void quotas.refresh();
    void openRouter.refresh();
  }

  export function refreshState(): { busy: boolean; disabled: boolean } {
    return { busy: refreshing, disabled: !client || !workspace || refreshing || !statisticsOpen };
  }
</script>

<section class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel" aria-label="Usage statistics">
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
      <UsageProviderLimits statuses={quotaStatuses} entries={quotas.entries} loading={quotas.busy} failed={quotas.error} order={sections.providerOrder} openRouter={openRouter.usage} openRouterStale={openRouter.error} />
      <div class="flex flex-wrap items-center gap-1.5 px-3 pt-2">
        <UsageSegmented value={period} options={PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))} ariaLabel="Period" onChange={(value) => period = value} />
      </div>
      <UsageSourceView {snapshot} {period} {nowMs} {workspace} loading={store.busy || snapshot?.status === "loading"} {...(onOpenSession ? { onOpenSession } : {})} />
    {/if}
  </div>
</section>
