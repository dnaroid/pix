<script lang="ts">
  import Workflow from "@lucide/svelte/icons/workflow";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { onMount } from "svelte";
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
  let details = $state<HTMLDetailsElement>();
  let receivedInitialSnapshot = false;
  let manuallyToggled = false;
  let defaultOpen: boolean | undefined;

  function applyInitialOpenState(): void {
    if (receivedInitialSnapshot || snapshot === undefined) return;
    receivedInitialSnapshot = true;
    defaultOpen = runs.length > 0;
    if (details) details.open = defaultOpen;
  }

  // A session-state bridge can arrive after the inspector mounts. Apply the
  // content-sensitive default once, but never bind `open`: native toggles then
  // remain the source of truth for ordinary snapshot updates.
  $effect(() => {
    if (!manuallyToggled) applyInitialOpenState();
  });

  onMount(applyInitialOpenState);

  function noteToggle(): void {
    if (defaultOpen !== undefined && details?.open === defaultOpen) return;
    manuallyToggled = true;
  }

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

<details bind:this={details} class="group border-b border-border" ontoggle={noteToggle}>
  <summary class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2.5 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
    <Workflow class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span class="font-semibold uppercase tracking-wide text-foreground">Agents</span>
    <span class="ml-auto font-mono tabular-nums text-muted-foreground">{activeCount} active</span>
    <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
  </summary>

  <div>
    {#if runs.length === 0}
      <div class="border-b border-border px-2.5 py-3 text-xs text-muted-foreground">No active agents</div>
    {:else}
      <div>
        {#each runs as run (run.runDir)}
          <section aria-label={`Subagent run ${sessionSubagentRunName(run.runDir)}`}>
            <h3 class="truncate border-b border-border bg-chrome/45 px-2.5 py-1 font-mono text-xs font-medium text-muted-foreground" title={run.runDir}>
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
                        <h4 class="min-w-0 flex-1 truncate font-mono text-xs font-semibold leading-4 text-foreground" title={agent.id}>{agent.id}</h4>
                        <span class={["shrink-0 text-xs font-medium", statusTone(agent.status)]}>{statusLabel(agent.status)}</span>
                        <span class="shrink-0 font-mono text-xs text-muted-foreground">{formatSessionSubagentElapsed(agent.startedAt, snapshot?.checkedAt ?? Date.now())}</span>
                      </div>
                      <p class="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-muted-foreground">{task}</p>
                      <div class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
</details>
