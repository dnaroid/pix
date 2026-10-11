<script lang="ts">
  import { codeDefaults, knowledgeDefaults } from "../../../../external/pi-tools-suite/src/project-search/source-extension-settings.mjs";
  import { parseSettingsSource, settingsValue, updateSettingsSource } from "../../lib/settings";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsExtensionList from "./SettingsExtensionList.svelte";

  let { source, onChange }: { source: string; onChange: (source: string) => void } = $props();
  const parsed = $derived(parseSettingsSource(source).value);
  const fields = [
    { key: "codeExtensions", label: "Code extensions", defaults: codeDefaults },
    { key: "knowledgeExtensions", label: "Knowledge extensions", defaults: knowledgeDefaults },
  ];
  function display(key: string, defaults: string[]): string[] {
    const value = settingsValue(parsed, ["search", key]);
    return Array.isArray(value) ? value.map(String) : defaults;
  }
  function update(key: string, values: string[]) {
    onChange(updateSettingsSource(source, ["search", key], values));
  }
</script>

<div class="px-2.5 py-2.5">
  <h2 class="text-sm font-semibold text-foreground">Indexing extensions</h2>
  <p class="mt-1 text-xs leading-4 text-muted-foreground">Complete lists from the suite config. Separate extensions with commas or spaces. Missing lists use the defaults shown; empty lists disable that category. No extensions are added to an explicit list. Use Save above. Changes apply on the next search or manual indexing; saving does not start repository indexing.</p>
</div>
{#each fields as field (field.key)}
  <SettingsFieldRow label={field.label} description="Optional leading dot; case-insensitive. Code and Knowledge lists must not overlap.">
    <SettingsExtensionList label={field.label} value={display(field.key, field.defaults)} onChange={(values) => update(field.key, values)} />
  </SettingsFieldRow>
{/each}
