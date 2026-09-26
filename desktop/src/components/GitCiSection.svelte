<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Minus from "@lucide/svelte/icons/minus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import X from "@lucide/svelte/icons/x";
  import { openExternalHref } from "../lib/external-links";
  import {
    gitCiAggregate,
    gitCiStatusLabel,
    type GitCiPanelState,
    type GitCiStatus,
  } from "../lib/git-ci";

  let { ci }: { ci: GitCiPanelState } = $props();

  const aggregate = $derived(gitCiAggregate(ci.snapshot));
  const providerLabel = $derived(ci.snapshot?.provider === "github" ? "GitHub Actions" : ci.snapshot?.provider === "gitlab" ? "GitLab CI" : "CI");

  function statusClass(status: GitCiStatus | undefined): string {
    if (status === "success") return "text-tool-success";
    if (status === "failure") return "text-tool-error";
    if (status === "queued" || status === "running") return "text-tool-warning";
    return "text-muted-foreground";
  }

  function availabilityMessage(): string | undefined {
    const snapshot = ci.snapshot;
    if (!snapshot) return ci.error ?? undefined;
    if (snapshot.availability === "noRemote") return "Add a Git remote to track CI for this repository.";
    if (snapshot.availability === "ambiguousRemote") return snapshot.error ?? "Configure an upstream or origin remote to choose the CI repository.";
    if (snapshot.availability === "unsupportedRemote") return snapshot.error ?? "Only GitHub and GitLab remotes are supported.";
    if (snapshot.availability === "cliMissing") return snapshot.error ?? "Install the matching Git provider CLI.";
    if (snapshot.availability === "authRequired") return snapshot.error ?? "Authenticate the matching Git provider CLI.";
    if (snapshot.availability === "error") return snapshot.error ?? "CI status could not be read.";
    if (snapshot.runs.length === 0 && snapshot.localOnly) return "This HEAD is not on the selected remote yet. Push it to start remote CI.";
    if (snapshot.runs.length === 0) return "No CI runs were found for this HEAD.";
    return undefined;
  }

  function openUrl(url: string | undefined): void {
    if (!url) return;
    void openExternalHref(url).catch(() => undefined);
  }
</script>

<details class="border-t border-sidebar-border bg-panel">
  <summary class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
    <ChevronDown class="h-3.5 w-3.5" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate">{providerLabel}</span>
    {#if ci.loading}
      <RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      <span>checking</span>
    {:else if ci.snapshot?.availability === "ready"}
      <span class={["inline-flex items-center gap-1", statusClass(aggregate)]}>
        {#if aggregate === "success"}<Check class="h-3.5 w-3.5" aria-hidden="true" />
        {:else if aggregate === "failure"}<X class="h-3.5 w-3.5" aria-hidden="true" />
        {:else if aggregate === "queued" || aggregate === "running"}<RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        {:else}<Minus class="h-3.5 w-3.5" aria-hidden="true" />{/if}
        {gitCiStatusLabel(aggregate)}
      </span>
    {:else if ci.snapshot}
      <span class="text-tool-warning">setup</span>
    {/if}
  </summary>

  <div class="space-y-2 px-2 pb-3">
    <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span class="min-w-0 truncate" title={ci.snapshot?.project}>{ci.snapshot?.project ?? "Current HEAD"}</span>
      <button class="shrink-0 rounded-sm px-1 hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={ci.loading} onclick={ci.onRefresh}>Refresh</button>
    </div>

    {#if availabilityMessage()}
      <p class={["text-xs leading-4 break-words", ci.snapshot?.availability === "error" || ci.error ? "text-tool-error" : "text-muted-foreground"]} role={ci.snapshot?.availability === "error" || ci.error ? "alert" : undefined}>{availabilityMessage()}</p>
    {/if}

    {#each ci.snapshot?.runs ?? [] as run (run.id)}
      <details class="rounded-md border border-border bg-panel-strong" ontoggle={(event) => { if (event.currentTarget.open) ci.onLoadJobs(run.id); }}>
        <summary class="flex min-h-8 cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          {#if run.status === "success"}<Check class="h-3.5 w-3.5 shrink-0 text-tool-success" aria-hidden="true" />
          {:else if run.status === "failure"}<X class="h-3.5 w-3.5 shrink-0 text-tool-error" aria-hidden="true" />
          {:else if run.status === "queued" || run.status === "running"}<RefreshCw class="h-3.5 w-3.5 shrink-0 text-tool-warning" aria-hidden="true" />
          {:else}<Minus class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
          <span class="min-w-0 flex-1 truncate font-medium text-foreground" title={run.name}>{run.name}</span>
          <span class={["shrink-0", statusClass(run.status)]}>{gitCiStatusLabel(run.status)}</span>
          <ChevronDown class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </summary>
        <div class="space-y-2 border-t border-border px-2 py-2">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span class="min-w-0 flex-1 truncate font-mono" title={run.headSha}>{run.headSha.slice(0, 8)}{run.branch ? ` · ${run.branch}` : ""}</span>
            {#if run.url}<button class="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => openUrl(run.url)}>Open <ExternalLink class="h-3 w-3" aria-hidden="true" /></button>{/if}
          </div>
          {#if ci.jobsLoading.has(run.id)}
            <p class="flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />Loading jobs…</p>
          {:else if ci.jobsErrors.get(run.id)}
            <p class="text-xs leading-4 text-tool-error break-words" role="alert">{ci.jobsErrors.get(run.id)}</p>
          {:else if ci.jobs.has(run.id)}
            <ol class="space-y-1">
              {#each ci.jobs.get(run.id) ?? [] as job (job.id)}
                <li class="flex min-w-0 items-center gap-1.5 text-xs">
                  {#if job.status === "success"}<Check class="h-3 w-3 shrink-0 text-tool-success" aria-hidden="true" />
                  {:else if job.status === "failure"}<X class="h-3 w-3 shrink-0 text-tool-error" aria-hidden="true" />
                  {:else if job.status === "queued" || job.status === "running"}<RefreshCw class="h-3 w-3 shrink-0 text-tool-warning" aria-hidden="true" />
                  {:else}<Minus class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
                  <span class="min-w-0 flex-1 truncate" title={job.stage ? `${job.stage} · ${job.name}` : job.name}>{job.stage ? `${job.stage} · ` : ""}{job.name}</span>
                  <span class={["shrink-0", statusClass(job.status)]}>{gitCiStatusLabel(job.status)}</span>
                  {#if job.url}<button class="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" title="Open job" aria-label={`Open ${job.name}`} onclick={() => openUrl(job.url)}><ExternalLink class="h-3 w-3" aria-hidden="true" /></button>{/if}
                </li>
              {:else}
                <li class="text-xs text-muted-foreground">No jobs reported for this run.</li>
              {/each}
            </ol>
          {/if}
        </div>
      </details>
    {/each}
  </div>
</details>
