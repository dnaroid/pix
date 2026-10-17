<script lang="ts">
  import { getContext } from "svelte";
  import type { UsagePanelSections } from "../../app/usage-panel-sections.svelte";
  import { USAGE_SECTIONS_CONTEXT } from "../../lib/usage-panel-sections";
  import type { ModelUsageLimitWindow, ModelUsageStatus, RuntimeStatus } from "../../lib/acp-client";
  import type { ProviderUsageEntry } from "../../app/provider-usage.svelte";
  import { providerUsageLimits, providerUsageLimitKey, quotaProviderLabel, type ProviderUsageSummary } from "../../lib/provider-usage-limits";
  import ModelProviderIcon from "../ModelProviderIcon.svelte";
  import UsageLimitBars from "../UsageLimitBars.svelte";
  import UsageSection from "./UsageSection.svelte";
  import UsageSkeleton from "./UsageSkeleton.svelte";

  let { statuses, entries = [], loading = false, failed = false }: {
    statuses: readonly RuntimeStatus[];
    entries?: readonly ProviderUsageEntry[];
    loading?: boolean;
    failed?: boolean;
  } = $props();
  const sections = getContext<UsagePanelSections | undefined>(USAGE_SECTIONS_CONTEXT);
  const expanded = $derived(sections?.isOpen("provider-limits") ?? true);
  let now = $state(Date.now());
  const providers = $derived(expanded ? providerUsageLimits(statuses, now) : []);
  const missing = $derived.by(() => {
    const grouped = new Map<ModelUsageStatus["provider"], ProviderUsageEntry>();
    const priority = { loading: 0, failed: 1, unavailable: 2, ready: 3 };
    for (const entry of entries) {
      if (providers.some((usage) => usage.provider === entry.provider)) continue;
      const previous = grouped.get(entry.provider);
      if (!previous || priority[entry.state] < priority[previous.state]) grouped.set(entry.provider, entry);
    }
    return [...grouped.values()];
  });

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
  {#each providers as usage (providerUsageLimitKey(usage))}
    <div class="mb-2 flex min-w-0 flex-col gap-1 text-xs">
      <div class="flex min-w-0 items-center gap-1.5 font-medium">
        <ModelProviderIcon provider={usage.iconProvider} />
        <span>{quotaProviderLabel(usage.provider)}</span>
        {#if usage.accountEmail}<span class="min-w-0 truncate font-normal text-muted-foreground" title={usage.accountEmail}>{usage.accountEmail}</span>{/if}
      </div>
    </div>
    <UsageLimitBars windows={windows(usage)} {now} showHeading={false} stale={usage.stale === true} creditDeadlines={(usage.resetCredits ?? []).flatMap((credit) => credit.expiresAt !== undefined && credit.expiresAt > now ? [credit.expiresAt] : [])} />
  {/each}
  {#each missing as entry (entry.provider)}
    <div class="mb-2 flex min-w-0 flex-col gap-1 text-xs">
      <div class="flex items-center gap-1.5 font-medium">
        <ModelProviderIcon provider={entry.modelRef.split("/")[0] ?? entry.provider} />
        <span>{quotaProviderLabel(entry.provider)}</span>
      </div>
      {#if entry.state === "loading"}<UsageSkeleton label="Loading limits…" />{:else}<span class="text-muted-foreground">{missingMessage(entry)}</span>{/if}
    </div>
  {/each}
  {#if failed}
    <p class="m-0 text-xs leading-4 text-muted-foreground" role="status">Could not load provider limits. Try refreshing.</p>
  {:else if providers.length === 0 && missing.length === 0}
    {#if loading}<UsageSkeleton label="Loading provider limits…" tall />{:else}<p class="m-0 text-xs leading-4 text-muted-foreground">No provider limits available yet. Connect a supported provider to load its quota.</p>{/if}
  {/if}
</UsageSection>
