<script lang="ts">
  import Workflow from "@lucide/svelte/icons/workflow";
  import { agentIcon } from "../lib/agent-icons";
  import {
    formatSessionSubagentActivity,
    formatSessionSubagentElapsed,
    sessionSubagentModelLabel,
    sessionSubagentRunName,
    sessionSubagentTaskPreview,
    visibleSessionSubagentRuns,
    type SessionSubagentSnapshot,
    type SessionSubagentStatus,
  } from "../lib/session-subagents";

  let {
    snapshot,
    activeCount,
  }: {
    snapshot: SessionSubagentSnapshot | undefined;
    activeCount: number;
  } = $props();

  const runs = $derived(visibleSessionSubagentRuns(snapshot));

  function statusTone(status: SessionSubagentStatus): string {
    if (status === "running") return "text-tool-info";
    if (status === "retrying") return "text-tool-warning";
    if (status === "done") return "text-tool-success";
    if (status === "failed") return "text-tool-error";
    return "text-muted-foreground";
  }

  function statusLabel(status: SessionSubagentStatus): string {
    if (status === "retrying") return "Retrying";
    if (status === "running") return "Running";
    if (status === "done") return "Done";
    if (status === "failed") return "Failed";
    if (status === "stopped") return "Stopped";
    return "Planned";
  }
</script>

<section aria-labelledby="session-subagents-heading">
  <div class="flex h-8 items-center gap-1.5 border-b border-border px-2.5">
    <Workflow class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <h2 id="session-subagents-heading" class="text-[11px] font-semibold uppercase tracking-wide text-foreground">Agents</h2>
    {#if activeCount > 0}
      <span class="ml-auto font-mono text-[11px] text-muted-foreground">{activeCount}</span>
    {/if}
  </div>

  <div>
    {#if runs.length === 0}
      <div class="border-b border-border px-2.5 py-3 text-[11px] text-muted-foreground">No active agents</div>
    {:else}
      <div>
        {#each runs as run (run.runDir)}
          <section aria-label={`Subagent run ${sessionSubagentRunName(run.runDir)}`}>
            <h3 class="truncate border-b border-border bg-chrome/45 px-2.5 py-1 font-mono text-[10px] font-medium text-muted-foreground" title={run.runDir}>
              {sessionSubagentRunName(run.runDir)}
            </h3>
            <div>
              {#each run.agents as agent (`${run.runDir}\0${agent.id}`)}
                {@const preview = sessionSubagentTaskPreview(run, agent.id)}
                {@const task = preview?.task?.trim() || preview?.scope?.trim() || "Task unavailable"}
                {@const AgentIcon = agentIcon(preview?.icon)}
                <article class="border-b border-border px-2.5 py-2 transition-colors hover:bg-panel-hover" aria-label={`Subagent ${agent.id}: ${statusLabel(agent.status)}`}>
                  <div class="flex min-w-0 items-start gap-2">
                    <span class={["mt-px shrink-0", statusTone(agent.status)]} title={`Agent type: ${preview?.icon?.trim() || "agent"} · ${statusLabel(agent.status)}`}>
                      <AgentIcon class="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 items-center gap-2">
                        <h4 class="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold leading-4 text-foreground" title={agent.id}>{agent.id}</h4>
                        <span class={["shrink-0 text-[10px] font-medium", statusTone(agent.status)]}>{statusLabel(agent.status)}</span>
                        <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{formatSessionSubagentElapsed(agent.startedAt, snapshot?.checkedAt ?? Date.now())}</span>
                      </div>
                      <p class="mt-0.5 line-clamp-2 break-words text-[11px] leading-3.5 text-muted-foreground">{task}</p>
                      <div class="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span class="shrink-0 font-mono">{sessionSubagentModelLabel(preview)}</span>
                        {#if agent.lastActivity}
                          <span class="text-muted-foreground/50">·</span>
                          <span class="min-w-0 truncate font-mono text-foreground/80">{formatSessionSubagentActivity(agent.lastActivity)}</span>
                        {/if}
                        {#if agent.retryCount}<span class="shrink-0 text-tool-warning">retry {agent.retryCount}</span>{/if}
                      </div>
                    </div>
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
