<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { BUILTIN_AGENT_CATALOG } from "../../lib/builtin-agent-catalog";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import { parseSettingsSource, settingsValue, settingsHasValue, removeSettingsValue, updateSettingsSource } from "../../lib/settings";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";

  let { source, models, onChange }: {
    source: string;
    models: readonly ModelThinkingModel[];
    onChange: (source: string) => void;
  } = $props();

  const agents = BUILTIN_AGENT_CATALOG.filter((agent) => agent.defaultModel);
  const choices = $derived(models.filter((model) => model.ref !== "pix:auto"));
  const parsed = $derived(parseSettingsSource(source).value);
  const path = (name: string) => ["builtinAgentModels", name];

  function value(name: string): string {
    const configured = settingsValue(parsed, path(name));
    return typeof configured === "string" ? configured : "";
  }
</script>

<details class="group">
  <summary class="flex cursor-pointer list-none items-center gap-2 py-1.5 text-xs text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
    <span>Models for {agents.length} bundled roles</span>
  </summary>
  <p class="pb-2 text-xs leading-4 text-muted-foreground">Primary model for new launches; authored fallback chains and role policies still apply. Project-local replacements are unaffected. Reset removes this level’s choice, allowing inherited user settings or the current suite default.</p>
  {#each agents as agent (agent.name)}
    <SettingsFieldRow label={agent.name} description={agent.description}
      explicit={settingsHasValue(parsed, path(agent.name))}
      defaultLabel={`Default / inherited · suite: ${agent.defaultModel}`}
      onReset={() => onChange(removeSettingsValue(source, path(agent.name)))}>
      <SettingsModelSelect value={value(agent.name)} models={choices}
        emptyLabel={`Default / inherited · suite: ${agent.defaultModel}`}
        ariaLabel={`Model for bundled agent ${agent.name}`}
        onChange={(ref) => onChange(updateSettingsSource(source, path(agent.name), ref))} />
    </SettingsFieldRow>
  {/each}
</details>
