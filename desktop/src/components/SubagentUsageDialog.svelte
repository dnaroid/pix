<script lang="ts">
  import { modalBackdropClass } from "../lib/dialog";
  import { iconButtonClass } from "../lib/icon-button";
  import X from "@lucide/svelte/icons/x";
  import Users from "@lucide/svelte/icons/users";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ModelProviderIcon from "./ModelProviderIcon.svelte";
  import ValidatedProjectPath from "./ValidatedProjectPath.svelte";
  import type { ProjectPathNavigation } from "../lib/project-path-navigation";
  import { modelProviderBrand } from "../lib/model-display";
  import type { SessionUsageReport } from "../lib/acp-client-types";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { agentIcon } from "../lib/agent-icons";
  import { formatSessionUsageTokens } from "../lib/session-usage";
  import { subagentUsageCost } from "../lib/subagent-usage";

  let { usage, loading = false, failed = false, pathNavigation, onRefresh, onClose }: {
    usage: SessionUsageReport;
    loading?: boolean;
    failed?: boolean;
    pathNavigation?: ProjectPathNavigation;
    onRefresh: () => void;
    onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  const stats = $derived(usage.subagents);
  const exactTokens = new Intl.NumberFormat("en");

  $effect(() => {
    if (dialog) return activateModalDialog(dialog, () => closeButton);
  });
</script>

<dialog
  bind:this={dialog}
  class={modalBackdropClass}
  aria-label="Subagent statistics"
  oncancel={(event) => { event.preventDefault(); onClose(); }}
  onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}
>
  <section class="flex max-h-[calc(100dvh-40px)] w-[640px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
    <header class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
      <Users class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 text-xs font-semibold">Subagent statistics</h2>
      <button type="button" class={iconButtonClass("md", "chrome")} aria-label="Refresh subagent statistics" disabled={loading} onclick={onRefresh}>
        <RotateCw class={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} aria-hidden="true" />
      </button>
      <button bind:this={closeButton} type="button" class={iconButtonClass("md", "chrome")} aria-label="Close subagent statistics" onclick={onClose}>
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </header>
    <div class="space-y-3 overflow-y-auto p-3 text-xs" aria-busy={loading}>
      {#if failed}<p role="status" class="text-destructive">Refresh failed. Showing the last recorded snapshot.</p>{/if}
      {#if stats}
        {#if stats.agents.length === 0}
          <p class="py-4 text-center text-muted-foreground">No recorded subagent runs in this session.</p>
        {/if}
        <div class="space-y-2">
          {#each stats.agents as agent (agent.key)}
            {@const Icon = agentIcon(agent.icon)}
            <details class="group/agent overflow-hidden rounded-md border border-border">
              <summary class="flex cursor-pointer list-none items-start gap-2 p-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/agent:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span class="font-medium">{agent.agentId}</span><span class="inline-flex items-center gap-1.5 text-muted-foreground"><Icon class="h-4 w-4 shrink-0 text-tool-search" aria-hidden="true" />{agent.subagentType ?? "Type not recorded"}</span></div>
                  <div class="mt-1 flex flex-wrap gap-x-2 gap-y-1 break-words text-muted-foreground">
                    {#if agent.models.length > 0}
                      {#each agent.models as item}
                        <span class="inline-flex min-w-0 items-center gap-1.5">{#if modelProviderBrand(item.provider)}<ModelProviderIcon provider={item.provider} />{/if}<span class="min-w-0 break-words">{item.provider}/{item.model}</span></span>
                      {/each}
                    {:else if agent.configuredModel}
                      <span class="inline-flex min-w-0 items-center gap-1.5">{#if modelProviderBrand(agent.configuredModel)}<ModelProviderIcon provider={agent.configuredModel} />{/if}<span class="min-w-0 break-words">{agent.configuredModel} (configured)</span></span>
                    {:else}
                      Model not recorded
                    {/if}
                  </div>
                </div>
                <div class="shrink-0 text-right tabular-nums">
                  {#if agent.usageRecorded}<div>{formatSessionUsageTokens(agent.totals.totalTokens)} tokens</div><div class="mt-1 text-muted-foreground">{subagentUsageCost(agent.totals)}</div>{:else}<span class="text-muted-foreground">Usage not recorded</span>{/if}
                </div>
              </summary>
              <div class="space-y-3 border-t border-border p-3">
                <div><h3 class="font-medium">Task</h3><p class="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{agent.task ?? "Task not recorded for this run."}</p>{#if agent.scope}<p class="mt-1 break-words text-muted-foreground">Scope: {agent.scope}</p>{/if}</div>
                {#if agent.tools?.length}
                  <ul aria-label="Tool calls" class="flex flex-wrap gap-1.5">{#each agent.tools as tool}<li class="rounded border border-border px-2 py-0.5 font-mono text-muted-foreground">{tool.name} ×{tool.count}</li>{/each}</ul>
                {/if}
                {#if agent.usageRecorded}
                  <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-4">
                    {#each [["Input", agent.totals.input], ["Output", agent.totals.output], ["Cache read", agent.totals.cacheRead], ["Cache write", agent.totals.cacheWrite]] as [label, value]}
                      <div><dt>{label}</dt><dd class="mt-0.5 tabular-nums text-foreground">{exactTokens.format(Number(value))}</dd></div>
                    {/each}
                  </dl>
                {/if}
                {#if agent.runDir}<p class="break-all font-mono text-muted-foreground">Run: <ValidatedProjectPath path={agent.runDir} kind="directory" navigation={pathNavigation} onNavigate={onClose} /></p>{:else}<p class="text-muted-foreground">Run identity not recorded (legacy usage).</p>{/if}
              </div>
            </details>
          {/each}
        </div>
      {:else}
        <p class="text-muted-foreground">Subagent breakdown is unavailable from this runtime. Update the runtime to record detailed statistics.</p>
      {/if}
    </div>
  </section>
</dialog>
