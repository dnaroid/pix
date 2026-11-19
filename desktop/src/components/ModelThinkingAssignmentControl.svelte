<script lang="ts">
  import BrainCircuit from "@lucide/svelte/icons/brain-circuit";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { btwModelPickerConfig } from "../app/btw-model";
  import { parseDesktopModelRef } from "../app/desktop-helpers";
  import { modelDisplayToneClass, modelRefTone, thinkingLevelTone } from "../lib/model-display";
  import { AUTO_MODEL_REF, modelThinkingConfigState } from "../lib/model-thinking";
  import ModelThinkingPicker from "./ModelThinkingPicker.svelte";

  let {
    value = $bindable(""),
    configOptions,
    visibleModelRefs,
    rememberedThinkingByModel = {},
    onVisibleModelsChange,
    disabled = false,
    workspace = "",
    label,
    triggerLabel,
    help,
    selectionDescription,
    optional = false,
    class: sectionClass = "",
  }: {
    value: string;
    configOptions: readonly SessionConfigOption[];
    visibleModelRefs?: readonly string[];
    rememberedThinkingByModel?: Readonly<Record<string, string>>;
    onVisibleModelsChange: (modelRefs: readonly string[]) => Promise<void> | void;
    disabled?: boolean;
    workspace?: string;
    label: string;
    triggerLabel: string;
    help: string;
    selectionDescription: string;
    optional?: boolean;
    class?: string;
  } = $props();
  const ids = $props.id();

  let trigger = $state<HTMLButtonElement | null>(null);
  let pickerOpen = $state(false);
  let pickerOptions = $state.raw<readonly SessionConfigOption[]>([]);
  const parsed = $derived(value ? parseDesktopModelRef(value) : null);
  const modelState = $derived(modelThinkingConfigState(configOptions));
  const models = $derived(modelState.models.filter((model) => model.ref !== AUTO_MODEL_REF));
  const selectedModel = $derived(parsed ? models.find((model) => model.ref === parsed.modelRef) : undefined);
  const selectedThinking = $derived(parsed?.thinking ?? (parsed ? "session default" : ""));

  function openPicker(): void {
    if (disabled || models.length === 0) return;
    if (pickerOpen) { pickerOpen = false; return; }
    pickerOptions = btwModelPickerConfig(configOptions, parsed?.modelRef ?? null, parsed?.thinking ?? null);
    pickerOpen = true;
  }

  function assign(ref: string, effort: string): void {
    // The selected effort is explicit: model-only refs intentionally keep the
    // session's own thinking default, whereas an explicit off must stay off.
    value = `${ref}:${effort}`;
  }

  $effect(() => { if (disabled) pickerOpen = false; });
</script>

<section class={["space-y-1.5", sectionClass]} aria-labelledby={`${ids}-label`}>
  <div id={`${ids}-label`} class="flex items-center gap-1.5 text-xs font-medium text-foreground">
    <BrainCircuit class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    {label}{#if optional} <span class="font-normal text-muted-foreground">(optional)</span>{/if}
  </div>
  <div class="flex min-w-0 items-center gap-1.5">
    <button
      bind:this={trigger}
      type="button"
      class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs text-foreground transition-colors hover:border-ring/55 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-45"
      aria-label={triggerLabel}
      aria-describedby={`${ids}-help`}
      aria-haspopup="dialog"
      aria-expanded={pickerOpen}
      disabled={disabled || models.length === 0}
      title={value || "Use session default"}
      onclick={openPicker}
    >
      <span class={["min-w-0 flex-1 truncate", parsed ? modelDisplayToneClass(modelRefTone(parsed.modelRef)) : "text-muted-foreground"]}>
        {parsed ? selectedModel?.name ?? parsed.modelRef : models.length ? "Use session default" : "Model catalog unavailable"}
      </span>
      {#if parsed}<span class={["shrink-0 font-mono text-xs", modelDisplayToneClass(thinkingLevelTone(parsed.thinking ?? "off", selectedModel?.thinkingLevels ?? ["off"]))]}>{selectedThinking}</span>{/if}
      <ChevronDown class={["h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", pickerOpen ? "rotate-180" : "rotate-0"]} aria-hidden="true" />
    </button>
    {#if value}
      <button
        type="button"
        class="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-45"
        aria-label="Use session default model"
        title="Use session default model and effort"
        disabled={disabled}
        onclick={() => { pickerOpen = false; value = ""; }}
      ><RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /></button>
    {/if}
  </div>
  <p id={`${ids}-help`} class="text-xs leading-4 text-muted-foreground">{help}</p>
</section>

{#if pickerOpen && trigger}
  <ModelThinkingPicker
    configOptions={pickerOptions}
    {workspace}
    {visibleModelRefs}
    {rememberedThinkingByModel}
    {onVisibleModelsChange}
    {disabled}
    applyUnchanged
    anchor={trigger}
    {selectionDescription}
    onApply={assign}
    onClose={() => { pickerOpen = false; }}
    restoreFocus={() => trigger?.focus()}
  />
{/if}
