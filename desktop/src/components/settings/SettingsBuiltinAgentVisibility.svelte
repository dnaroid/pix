<script lang="ts">
  import { agentIcon } from "../../lib/agent-icons";
  import type { BuiltinAgentCatalogEntry } from "../../lib/builtin-agent-catalog";

  let {
    value,
    agents,
    onChange,
  }: {
    value: readonly string[];
    agents: readonly BuiltinAgentCatalogEntry[];
    onChange: (value: string[]) => void;
  } = $props();

  const disabled = $derived(new Set(value));
  const knownNames = $derived(new Set(agents.map((agent) => agent.name)));
  const unknown = $derived(value.filter((name) => !knownNames.has(name)));
  const enabledCount = $derived(agents.filter((agent) => !disabled.has(agent.name)).length);

  function toggle(name: string): void {
    const next = new Set(value);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next].sort());
  }
</script>

<details class="group rounded-md border border-border bg-panel-strong">
  <summary class="flex min-h-7 cursor-pointer list-none items-center justify-between gap-3 px-2 py-1 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
    <span>Choose enabled agents</span>
    <span class="shrink-0 text-muted-foreground">{enabledCount}/{agents.length} enabled</span>
  </summary>
  <div class="border-t border-border px-2 py-1.5">
    {#each agents as agent (agent.name)}
      {@const AgentIcon = agentIcon(agent.icon)}
      <label class="flex min-h-7 cursor-pointer items-center gap-2 py-1 text-xs text-foreground" title={agent.description}>
        <input
          class="h-3.5 w-3.5 accent-primary"
          type="checkbox"
          checked={!disabled.has(agent.name)}
          onchange={() => toggle(agent.name)}
        />
        <AgentIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 truncate font-mono">{agent.name}</span>
      </label>
    {/each}
    {#if unknown.length > 0}
      <div class="mt-1 border-t border-border pt-1.5 text-xs leading-4 text-muted-foreground">
        Unknown disabled names are preserved: <span class="font-mono">{unknown.join(", ")}</span>
      </div>
    {/if}
  </div>
</details>
