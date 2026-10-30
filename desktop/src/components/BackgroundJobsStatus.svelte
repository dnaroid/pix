<script lang="ts">
  import {
    backgroundJobStatusLabel,
    backgroundJobTailLines,
    isLiveBackgroundJob,
    type BackgroundJobsSnapshot,
  } from "../lib/background-jobs";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import StatusBarPopover from "./StatusBarPopover.svelte";

  let { snapshot, disabled = false, isPending = () => false, onKill, onKillAll, onKillOrphans, onOpenLog }: {
    snapshot: BackgroundJobsSnapshot;
    disabled?: boolean;
    isPending?: (command: string) => boolean;
    onKill: (jobId: string) => void;
    onKillAll: () => void;
    onKillOrphans: () => void;
    onOpenLog: (path: string) => void;
  } = $props();

  const live = $derived(snapshot.jobs.filter(isLiveBackgroundJob));
  // Newest first; finished jobs stay visible so their final output can be inspected.
  const jobs = $derived([...snapshot.jobs].sort((a, b) => b.startedAt - a.startedAt));
  const label = $derived(`${live.length} background ${live.length === 1 ? "job" : "jobs"}${snapshot.orphans.length ? `, ${snapshot.orphans.length} orphaned` : ""}`);
  const buttonClass = "rounded-sm border border-border px-2 py-0.5 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
</script>

<StatusBarPopover label="Background jobs">
  {#snippet trigger({ open, toggle, id })}
    <button
      class={["relative grid h-6 w-6 place-items-center rounded-sm bg-transparent transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        snapshot.orphans.length ? "text-tool-warning" : live.length ? "text-tool-success" : "text-muted-foreground"]}
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      data-background-jobs-status
      onclick={toggle}
    >
      <SquareTerminal
        class={["h-3.5 w-3.5", live.length && "animate-pulse motion-reduce:animate-none"]}
        aria-hidden="true"
      />
      {#if live.length > 1}
        <span class="pointer-events-none absolute -top-0.5 right-0 min-w-3 rounded-full bg-chrome px-0.5 font-mono text-xs leading-3 tabular-nums" aria-hidden="true" data-background-jobs-count>{live.length}</span>
      {/if}
    </button>
  {/snippet}
  {#snippet children()}
    <div class="flex w-80 flex-col gap-2 rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md" data-background-jobs-popover>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Background jobs</span>
        {#if live.length > 1}
          <button class={buttonClass} type="button" disabled={disabled || isPending("/background-jobs kill-all")} onclick={onKillAll}>Stop all</button>
        {/if}
      </div>
      {#if !jobs.length}
        <p class="text-xs text-muted-foreground">No background jobs in this session.</p>
      {/if}
      {#each jobs as job (job.id)}
        {@const tail = backgroundJobTailLines(job.tail)}
        <details class="group/job min-w-0 border-t border-border pt-1.5 first-of-type:border-t-0 first-of-type:pt-0" open={isLiveBackgroundJob(job)} data-background-job={job.id}>
          <summary class="flex min-w-0 list-none items-center gap-2 rounded-sm hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/job:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={job.command}>{job.description ?? job.command}</span>
            <span class={["shrink-0 text-xs", isLiveBackgroundJob(job) ? "text-tool-success" : job.status === "exited" && job.exitCode === 0 ? "text-muted-foreground" : "text-tool-error"]} data-background-job-status={job.status}>{backgroundJobStatusLabel(job)}</span>
          </summary>
          <div class="mt-1 flex min-w-0 flex-col gap-1">
            {#if tail}
              <pre class="max-h-24 overflow-auto rounded-sm bg-muted/40 px-1.5 py-1 font-mono text-xs leading-4 whitespace-pre-wrap break-all text-muted-foreground" data-background-job-tail>{tail}</pre>
            {/if}
            <div class="flex items-center gap-1.5">
              {#if isLiveBackgroundJob(job)}
                <button class={buttonClass} type="button" aria-label={`Stop background job ${job.id}`} data-background-job-kill
                  disabled={disabled || isPending(`/background-jobs kill ${job.id}`)} onclick={() => onKill(job.id)}>Kill</button>
              {/if}
              <button class={buttonClass} type="button" data-background-job-open-log onclick={() => onOpenLog(job.logPath)}>Open log</button>
              <span class="ml-auto font-mono text-xs text-muted-foreground/70">{job.id}</span>
            </div>
          </div>
        </details>
      {/each}
      {#if snapshot.orphans.length}
        <div class="flex flex-col gap-1 border-t border-border pt-1.5" data-background-orphans>
          <span class="text-xs font-medium text-tool-warning">Left running by a previous Pix process</span>
          {#each snapshot.orphans as orphan (orphan.jobId)}
            <span class="truncate font-mono text-xs text-muted-foreground" title={orphan.command}>pid {orphan.pid}: {orphan.command}</span>
          {/each}
          <div class="flex items-center gap-1.5">
            <button class={buttonClass} type="button" disabled={disabled || isPending("/background-jobs kill-orphans")} onclick={onKillOrphans}>Stop orphans</button>
          </div>
        </div>
      {/if}
    </div>
  {/snippet}
</StatusBarPopover>
