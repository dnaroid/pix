<script lang="ts">
  import { getContext } from "svelte";
  import type { UsagePanelSections } from "../../app/usage-panel-sections.svelte";
  import { USAGE_SECTIONS_CONTEXT } from "../../lib/usage-panel-sections";
  import type { ModelUsageLimitWindow, RuntimeStatus } from "../../lib/acp-client";
  import type { ProviderUsageEntry } from "../../app/provider-usage.svelte";
  import { quotaProviderLabel, type ProviderUsageSummary } from "../../lib/provider-usage-limits";
  import { providerUsageRows } from "../../lib/provider-usage-rows";
  import ModelProviderIcon from "../ModelProviderIcon.svelte";
  import UsageLimitBars from "../UsageLimitBars.svelte";
  import UsageSection from "./UsageSection.svelte";
  import UsageSkeleton from "./UsageSkeleton.svelte";

  let { statuses, entries = [], loading = false, failed = false, order = [] }: {
    statuses: readonly RuntimeStatus[];
    entries?: readonly ProviderUsageEntry[];
    loading?: boolean;
    failed?: boolean;
    order?: readonly string[];
  } = $props();
  const sections = getContext<UsagePanelSections | undefined>(USAGE_SECTIONS_CONTEXT);
  const expanded = $derived(sections?.isOpen("provider-limits") ?? true);
  let now = $state(Date.now());
  const rows = $derived(expanded ? providerUsageRows(statuses, entries, now, order) : []);

  $effect(() => {
    if (!expanded) return;
    now = Date.now();
    const timer = window.setInterval(() => now = Date.now(), 60_000);
    return () => window.clearInterval(timer);
  });

  function missingMessage(entry: ProviderUsageEntry): string {
    if (entry.state === "failed") return "Could not refresh limits. Try again.";
    return "Quota unavailable for this account.";
  }

  function windows(usage: ProviderUsageSummary): { key: string; label: "H" | "W"; window: ModelUsageLimitWindow }[] {
    const result: { key: string; label: "H" | "W"; window: ModelUsageLimitWindow }[] = [];
    if (usage.hourly) result.push({ key: "H", label: "H", window: usage.hourly });
    if (usage.weekly) result.push({ key: "W", label: "W", window: usage.weekly });
    return result;
  }
</script>

<UsageSection title="Provider limits" sectionId="provider-limits" {loading}>
  {#each rows as row (row.key)}
    <div class="mb-2 flex min-w-0 flex-col gap-1 text-xs">
      <div class="flex min-w-0 items-center gap-1.5 font-medium">
        <ModelProviderIcon provider={row.kind === "quota" ? row.usage.iconProvider : row.entry.modelRef.split("/")[0] ?? row.provider} />
        <span>{quotaProviderLabel(row.provider)}</span>
        {#if row.kind === "quota" && row.usage.accountEmail}<span class="min-w-0 truncate font-normal text-muted-foreground" title={row.usage.accountEmail}>{row.usage.accountEmail}</span>{/if}
      </div>
      {#if row.kind === "missing"}
        {#if row.entry.state === "loading"}<UsageSkeleton label="Loading limits…" />{:else}<span class="text-muted-foreground">{missingMessage(row.entry)}</span>{/if}
      {/if}
    </div>
    {#if row.kind === "quota"}
      <UsageLimitBars windows={windows(row.usage)} {now} showHeading={false} stale={row.usage.stale === true} creditDeadlines={(row.usage.resetCredits ?? []).flatMap((credit) => credit.expiresAt !== undefined && credit.expiresAt > now ? [credit.expiresAt] : [])} />
    {/if}
  {/each}
  {#if failed}
    <p class="m-0 text-xs leading-4 text-muted-foreground" role="status">Could not load provider limits. Try refreshing.</p>
  {:else if rows.length === 0}
    {#if loading}<UsageSkeleton label="Loading provider limits…" tall />{:else}<p class="m-0 text-xs leading-4 text-muted-foreground">No provider limits available yet. Connect a supported provider to load its quota.</p>{/if}
  {/if}
</UsageSection>
