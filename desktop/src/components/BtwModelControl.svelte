<script lang="ts">
  import { onDestroy } from "svelte";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { BtwPaneState } from "../app/btw.svelte";
  import type { createModelPreferencesStore } from "../app/model-preferences.svelte";
  import { btwModelPickerConfig } from "../app/btw-model";
  import { modelThinkingConfigState } from "../lib/model-thinking";
  import { modelRefTone, modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import ModelThinkingPicker from "./ModelThinkingPicker.svelte";

  let { chat, configOptions, preferences, ready, mainPickerOpen = false, beforeOpen, onSelect, onFocusInput }: {
    chat: BtwPaneState;
    configOptions: readonly SessionConfigOption[];
    preferences: ReturnType<typeof createModelPreferencesStore>;
    ready: boolean;
    mainPickerOpen?: boolean;
    beforeOpen?: () => void;
    onSelect: (modelRef: string | null, thinkingLevel: string | null) => void;
    onFocusInput: () => void;
  } = $props();

  let trigger = $state<HTMLButtonElement | null>(null);
  let open = $state(false);
  let loading = $state(false);
  let error = $state("");
  let pickerOptions = $state.raw<readonly SessionConfigOption[]>([]);
  let generation = 0;
  let alive = true;
  const config = $derived(modelThinkingConfigState(btwModelPickerConfig(configOptions, chat.modelRef, chat.thinkingLevel)));
  const inherited = $derived(chat.modelRef === null && chat.thinkingLevel === null);

  function close(): void { generation++; open = false; loading = false; }
  $effect(() => { if (!ready || mainPickerOpen) close(); });
  onDestroy(() => { alive = false; generation++; });

  async function toggle(): Promise<void> {
    if (open || loading) { close(); return; }
    if (!ready) return;
    beforeOpen?.();
    const ticket = ++generation;
    loading = true; error = "";
    try {
      await preferences.waitForVisibleModelsSave();
      if (!alive || ticket !== generation || !ready) return;
      await preferences.load();
      if (!alive || ticket !== generation || !ready || mainPickerOpen) return;
      pickerOptions = btwModelPickerConfig(configOptions, chat.modelRef, chat.thinkingLevel);
      open = true;
    } catch {
      if (alive && ticket === generation) error = "Could not load model preferences. Try again.";
    } finally { if (alive && ticket === generation) loading = false; }
  }
</script>

<div class="relative flex min-w-0 items-center gap-1">
  <button bind:this={trigger} type="button" aria-label="BTW model and effort" aria-haspopup="dialog" aria-expanded={open}
    class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm px-1.5 text-xs hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
    disabled={!ready} onclick={() => void toggle()} data-btw-model-trigger
    title={inherited ? "Model and effort follow the main session at submission time" : "Model and effort for the next side question only"}>
    <span class={["min-w-0 truncate", modelDisplayToneClass(modelRefTone(chat.modelRef ?? config.currentModel?.ref ?? ""))]}>
      {loading ? "Loading…" : config.currentModel?.name ?? chat.modelRef?.slice(chat.modelRef.indexOf("/") + 1) ?? "Model unavailable"}
    </span>
    <span class="text-muted-foreground" aria-hidden="true">·</span>
    <span class={["shrink-0", modelDisplayToneClass(thinkingLevelTone(config.currentThinking, config.currentThinkingLevels))]}>{config.currentThinking}</span>
  </button>
  {#if !inherited}<button type="button" aria-label="Use main model and effort for BTW"
    title="Use main model and effort for BTW"
    class="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring"
    onclick={() => { close(); onSelect(null, null); onFocusInput(); }}><RotateCcw size={13} /></button>{/if}
  {#if error}<p role="alert" class="absolute left-0 top-full z-50 rounded-sm border border-border bg-popover p-2 text-xs text-destructive">{error}</p>{/if}
</div>
{#if open && trigger}
  <ModelThinkingPicker configOptions={pickerOptions} visibleModelRefs={preferences.visibleModelRefs}
    rememberedThinkingByModel={{ ...preferences.rememberedThinkingByModel, ...chat.thinkingByModel }}
    anchor={trigger} disabled={!ready}
    selectionDescription="Applies to BTW side questions only. The main session is unchanged."
    onVisibleModelsChange={preferences.saveVisibleModelRefs}
    onApply={(ref, effort) => onSelect(ref, effort)} onClose={close} restoreFocus={onFocusInput} />
{/if}
