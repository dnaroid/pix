<script lang="ts">
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Workflow from "@lucide/svelte/icons/workflow";
  import {
    formatSessionSubagentElapsed,
    sessionSubagentCount,
    sessionSubagentModelLabel,
    sessionSubagentRunName,
    sessionSubagentTaskPreview,
    visibleSessionSubagentRuns,
    type SessionSubagentSnapshot,
    type SessionSubagentStatus,
  } from "../lib/session-subagents";

  let { snapshot }: { snapshot: SessionSubagentSnapshot | undefined } = $props();

  const runs = $derived(visibleSessionSubagentRuns(snapshot));
  const activeCount = $derived(sessionSubagentCount(snapshot));

  function statusTone(status: SessionSubagentStatus): string {
    return status === "planned" ? "text-[var(--tool-info)]" : "text-[var(--tool-warning)]";
  }

  function statusLabel(status: SessionSubagentStatus): string {
    if (status === "retrying") return "Retrying";
    if (status === "running") return "Running";
    return "Planned";
  }
</script>

<section aria-labelledby="session-subagents-heading">
  <div class="border-b border-sidebar-border p-2.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <Workflow class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <h2 id="session-subagents-heading" class="text-xs font-semibold text-foreground">Subagents</h2>
      </div>
      {#if activeCount > 0}
        <span class="text-[10px] text-muted-foreground">{activeCount} active · {runs.length} {runs.length === 1 ? "run" : "runs"}</span>
      {/if}
    </div>
    <p class="mt-1 text-[9px] leading-3.5 text-muted-foreground">Live delegated work for the active session.</p>
  </div>

  <div class="p-2">
    {#if runs.length === 0}
      <div class="px-4 py-5 text-center">
        <Workflow class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium">No active subagents</p>
        <p class="mt-1 text-[10px] leading-4 text-muted-foreground">Delegated runs appear here while they are active.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each runs as run (run.runDir)}
          <section aria-label={`Subagent run ${sessionSubagentRunName(run.runDir)}`}>
            <h3 class="mb-1.5 truncate px-0.5 font-mono text-[9px] font-medium text-muted-foreground" title={run.runDir}>
              {sessionSubagentRunName(run.runDir)}
            </h3>
            <div class="space-y-1.5">
              {#each run.agents as agent (`${run.runDir}\0${agent.id}`)}
                {@const preview = sessionSubagentTaskPreview(run, agent.id)}
                {@const task = preview?.task?.trim() || preview?.scope?.trim() || "Task unavailable"}
                <article class="rounded-lg border border-sidebar-border bg-background/55 p-2.5 shadow-xs" aria-label={`Subagent ${agent.id}: ${statusLabel(agent.status)}`}>
                  <div class="flex items-start gap-2">
                    <span class={["mt-0.5 shrink-0", statusTone(agent.status)]} title={statusLabel(agent.status)}>
                      {#if agent.status === "running"}
                        <LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {:else if agent.status === "retrying"}
                        <RotateCw class="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {:else}
                        <CircleDashed class="h-4 w-4" aria-hidden="true" />
                      {/if}
                    </span>
                    <div class="min-w-0 flex-1">
                      <h4 class="break-words font-mono text-[10px] font-semibold leading-4 text-foreground">{agent.id}</h4>
                      <p class="mt-0.5 line-clamp-3 break-words text-[10px] leading-3.5 text-muted-foreground">{task}</p>
                    </div>
                  </div>
                  <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground">
                    <span class={["font-medium", statusTone(agent.status)]}>{statusLabel(agent.status)}</span>
                    <span class="font-mono">{sessionSubagentModelLabel(preview)}</span>
                    <span>{formatSessionSubagentElapsed(agent.startedAt, snapshot?.checkedAt ?? Date.now())}</span>
                    {#if agent.retryCount}<span>retry {agent.retryCount}</span>{/if}
                  </div>
                </article>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</section>
