<script lang="ts">
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import { parseSettingsSource, settingsValue } from "../../lib/settings";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsModelSummary from "./SettingsModelSummary.svelte";

  let { source, models, desktop = false }: {
    source: string;
    models: readonly ModelThinkingModel[];
    desktop?: boolean;
  } = $props();

  const parsed = $derived(parseSettingsSource(source).value);
  const path = (field: string) => ["knowledgeCheck", field];
  function text(field: string): string {
    const value = settingsValue(parsed, path(field));
    return typeof value === "string" ? value : "";
  }
  const modelRef = $derived(text("modelRef"));
  const thinking = $derived(text("thinking") || (desktop ? "Use Tools Suite setting (Low when unset)" : "low"));
</script>

<SettingsFieldRow
  label="Contradiction judge model"
  description={desktop
    ? "Desktop override for manual and background Wiki checks. Managed in the model setup wizard → Features → Assistant; an empty override inherits Tools Suite."
    : "Shared Wiki judge. Managed in the model setup wizard → Features → Assistant. Desktop can override it; Search and session models are not fallbacks."}
>
  <SettingsModelSummary {models} rows={[{ label: desktop ? "Desktop override" : "Shared judge", ref: modelRef,
    emptyLabel: desktop ? "Use Tools Suite setting" : "No judge selected" }]} />
</SettingsFieldRow>
<SettingsFieldRow
  label="Contradiction judge thinking"
  description="Managed with the judge model in the setup wizard. Independent of RAG thinking; Off omits an explicit reasoning request."
>
  <span class="text-xs text-foreground" aria-label="Contradiction judge thinking">{thinking}</span>
</SettingsFieldRow>
