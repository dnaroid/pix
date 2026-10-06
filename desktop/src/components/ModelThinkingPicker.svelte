<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick, untrack } from "svelte";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import ModelProviderIcon from "./ModelProviderIcon.svelte";
  import { fuzzySearch } from "../lib/fuzzy";
  import { activateModelPickerPopover, modelPickerPopoverPosition } from "../lib/model-picker-popover";
  import { pickerModelIndex, nextPickerThinking } from "../lib/model-picker-navigation";
  import { modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import {
    AUTO_MODEL_REF,
    clampThinkingLevel,
    modelThinkingConfigState,
    type ModelThinkingModel,
  } from "../lib/model-thinking";
  import type { ModelDefaultSelection } from "../lib/model-default-preference";

  let {
    configOptions,
    visibleModelRefs,
    rememberedThinkingByModel = {},
    defaultSelection,
    disabled = false,
    onApply,
    onSetDefault,
    onVisibleModelsChange,
    onClose,
    restoreFocus,
    anchor,
    selectionDescription = "Choose both, then apply them together to this session.",
  }: {
    configOptions: readonly SessionConfigOption[];
    visibleModelRefs?: readonly string[];
    rememberedThinkingByModel?: Readonly<Record<string, string>>;
    defaultSelection?: ModelDefaultSelection;
    disabled?: boolean;
    onApply: (modelRef: string, thinkingLevel: string) => void | Promise<void>;
    onSetDefault?: (selection: ModelDefaultSelection) => void | Promise<void>;
    onVisibleModelsChange: (modelRefs: readonly string[]) => void | Promise<void>;
    onClose: () => void;
    restoreFocus?: () => void;
    anchor?: HTMLButtonElement;
    selectionDescription?: string;
  } = $props();

  const config = $derived(modelThinkingConfigState(configOptions));
  let dialogElement = $state<HTMLDialogElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let query = $state("");
  let selectedModelRef = $state("");
  let selectedThinking = $state("off");
  let selectedIndex = $state(0);
  let applying = $state(false);
  let savingDefault = $state(false);
  let savingVisibility = $state(false);
  let applyError = $state("");
  let visibilityMode = $state(false);
  let visibleRefs = $state<string[] | undefined>(undefined);
  let initialized = false;
  let alive = false;
  let popover: ReturnType<typeof activateModelPickerPopover> | undefined;
  let position = $state<ReturnType<typeof modelPickerPopoverPosition>>({ left: 8, bottom: 32, width: 520, maxHeight: 600 });
  const thinkingByModel = new Map<string, string>();

  const pickerModels = $derived(visibilityMode
    ? config.models.filter((model) => model.ref !== AUTO_MODEL_REF)
    : config.models.filter((model) => modelIsVisible(model)));
  const filteredModels = $derived.by(() => {
    const auto = visibilityMode ? undefined : pickerModels.find((model) => model.ref === AUTO_MODEL_REF);
    const models = pickerModels.filter((model) => model.ref !== AUTO_MODEL_REF);
    const filtered = fuzzySearch(
      models.map((model) => ({
      value: model,
      label: model.ref,
      aliases: [model.modelId, model.name, model.provider],
      keywords: [model.name, `${model.provider} ${model.modelId}`],
      })),
      query,
    ).map((match) => match.value);
    return auto ? [auto, ...filtered] : filtered;
  });
  const selectedModel = $derived(
    config.models.find((model) => model.ref === selectedModelRef) ?? config.currentModel ?? config.models[0],
  );
  const selectedAuto = $derived(selectedModel?.ref === AUTO_MODEL_REF);
  const selectedIsDefault = $derived.by(() => {
    if (!selectedModel || !defaultSelection) return false;
    if (selectedAuto) return defaultSelection.kind === "auto";
    return defaultSelection.kind === "model"
      && defaultSelection.modelRef === selectedModel.ref
      && defaultSelection.thinking === selectedThinking;
  });
  const dirty = $derived(
    !!selectedModel
      && (selectedModel.ref !== config.currentModel?.ref || selectedThinking !== config.currentThinking),
  );

  onMount(() => {
    alive = true;
    visibleRefs = visibleModelRefs === undefined ? undefined : [...visibleModelRefs];
    for (const [modelRef, thinkingLevel] of Object.entries(rememberedThinkingByModel)) {
      thinkingByModel.set(modelRef, thinkingLevel);
    }
    const initialModel = config.currentModel ?? filteredModels[0];
    if (initialModel) {
      selectedModelRef = initialModel.ref;
      selectedThinking = clampThinkingLevel(config.currentThinking, initialModel.thinkingLevels);
      thinkingByModel.set(initialModel.ref, selectedThinking);
    }
    selectedIndex = pickerModelIndex(filteredModels, selectedModelRef, query, visibilityMode);
    initialized = true;
    if (dialogElement) popover = activateModelPickerPopover(dialogElement, search, onClose, (next) => position = next, anchor);
    return () => {
      alive = false;
      popover?.dispose();
    };
  });

  function closePopup(): void {
    popover?.close();
  }

  $effect(() => {
    query;
    visibilityMode;
    if (!initialized) return;
    // Only query / mode changes should reset the staged model. `stageModel()`
    // reads selectedModelRef and selectedThinking, so without untrack those
    // reads become dependencies of this effect and a row click immediately
    // retriggers the effect, snapping the selection back to the first model.
    untrack(() => {
      selectedIndex = pickerModelIndex(filteredModels, selectedModelRef, query, visibilityMode);
      const first = filteredModels[selectedIndex];
      if (first && !visibilityMode) stageModel(first);
    });
  });

  $effect(() => {
    const model = filteredModels[selectedIndex];
    if (!model) return;
    void tick().then(() => {
      if (!alive) return;
      panel?.querySelector<HTMLElement>(`[data-model-ref="${CSS.escape(model.ref)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  function stageModel(model: ModelThinkingModel): void {
    if (selectedModelRef) thinkingByModel.set(selectedModelRef, selectedThinking);
    selectedModelRef = model.ref;
    selectedThinking = clampThinkingLevel(
      thinkingByModel.get(model.ref) ?? config.currentThinking,
      model.thinkingLevels,
    );
    thinkingByModel.set(model.ref, selectedThinking);
    applyError = "";
  }

  function stageThinking(level: string): void {
    if (!selectedModel?.thinkingLevels.includes(level)) return;
    selectedThinking = level;
    thinkingByModel.set(selectedModel.ref, level);
    applyError = "";
  }

  function moveModel(direction: 1 | -1): void {
    if (filteredModels.length === 0) return;
    selectedIndex = (selectedIndex + direction + filteredModels.length) % filteredModels.length;
    const model = filteredModels[selectedIndex];
    if (model && !visibilityMode) stageModel(model);
  }

  function modelIsVisible(model: ModelThinkingModel): boolean {
    if (model.ref === AUTO_MODEL_REF) return true;
    return model.current || visibleRefs === undefined || visibleRefs.includes(model.ref);
  }

  function toggleVisibilityMode(): void {
    if (applying || savingVisibility) return;
    visibilityMode = !visibilityMode;
    query = "";
    applyError = "";
    if (!visibilityMode) {
      const staged = config.models.find((model) => model.ref === selectedModelRef && modelIsVisible(model));
      const next = staged ?? config.currentModel ?? config.models.find((model) => modelIsVisible(model));
      if (next) stageModel(next);
    }
    selectedIndex = 0;
    void tick().then(() => search?.focus());
  }

  async function toggleModelVisibility(model: ModelThinkingModel): Promise<void> {
    if (disabled || applying || savingVisibility) return;
    if (model.current) {
      applyError = "The current model must remain visible until another model is selected.";
      return;
    }

    const next = new Set(visibleRefs === undefined ? config.models.map((candidate) => candidate.ref) : visibleRefs);
    if (next.has(model.ref)) next.delete(model.ref);
    else next.add(model.ref);
    if (config.currentModel) next.add(config.currentModel.ref);

    savingVisibility = true;
    applyError = "";
    try {
      const refs = [...next];
      await onVisibleModelsChange(refs);
      visibleRefs = refs;
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      savingVisibility = false;
    }
  }

  async function clearVisibleModels(): Promise<void> {
    if (disabled || applying || savingVisibility) return;
    savingVisibility = true;
    applyError = "";
    try {
      await onVisibleModelsChange([]);
      visibleRefs = [];
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      savingVisibility = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (!visibilityMode && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      moveThinking(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.target === search && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveModel(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.target === search && event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      toggleVisibilityMode();
      return;
    }
    if (event.target === search && event.key === "Enter") {
      event.preventDefault();
      const model = filteredModels[selectedIndex];
      if (visibilityMode) {
        if (model) void toggleModelVisibility(model);
      } else {
        void applySelection();
      }
      return;
    }
    if (!visibilityMode && event.target === search && event.key === "Tab" && !event.shiftKey) {
      if (selectedAuto) return;
      const level = selectedThinking;
      event.preventDefault();
      void tick().then(() => {
        panel?.querySelector<HTMLButtonElement>(`[data-thinking-level="${CSS.escape(level)}"]`)?.focus();
      });
    }
  }

  function handleModelKeydown(event: KeyboardEvent): void {
    // Select mode: Enter confirms the staged selection like the Apply button.
    // Manage mode keeps the native button activation (visibility toggle).
    if (visibilityMode || event.key !== "Enter") return;
    event.preventDefault();
    void applySelection();
  }

  function moveThinking(direction: 1 | -1, focus = false): void {
    if (!selectedModel || selectedAuto || disabled || applying) return;
    const next = nextPickerThinking(selectedModel.thinkingLevels, selectedThinking, direction);
    if (!next) return;
    stageThinking(next);
    if (focus) void tick().then(() => {
      panel?.querySelector<HTMLButtonElement>(`[data-thinking-level="${CSS.escape(next)}"]`)?.focus();
    });
  }

  function handleThinkingKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void applySelection();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    moveThinking(event.key === "ArrowRight" ? 1 : -1, true);
  }

  async function applySelection(): Promise<void> {
    if (!selectedModel || disabled || applying) return;
    if (!dirty) {
      confirmSelection();
      return;
    }
    applying = true;
    applyError = "";
    try {
      await onApply(selectedModel.ref, selectedThinking);
      if (!alive) return;
      confirmSelection();
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      applying = false;
    }
  }

  function confirmSelection(): void {
    // onClose invalidates the parent's conditional spread props immediately.
    // Capture the callback while the picker still owns its selection props.
    const focusComposer = restoreFocus;
    onClose();
    focusComposer?.();
  }

  async function setDefaultSelection(): Promise<void> {
    if (!onSetDefault || !selectedModel || disabled || applying || savingDefault) return;
    savingDefault = true;
    applyError = "";
    try {
      await onSetDefault(selectedAuto
        ? { kind: "auto" }
        : { kind: "model", modelRef: selectedModel.ref, thinking: selectedThinking });
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      savingDefault = false;
    }
  }

</script>

<dialog
  bind:this={dialogElement}
  open
  data-model-thinking-popover
  style:left={`${position.left}px`}
  style:top={position.top === undefined ? "auto" : `${position.top}px`}
  style:bottom={position.top === undefined ? `${position.bottom}px` : "auto"}
  style:width={`${position.width}px`}
  class="fixed z-50 m-0 max-w-none border-0 bg-transparent p-0 text-foreground"
  aria-labelledby="model-thinking-picker-title"
  onkeydown={handleKeydown}
>
  <div
    class="grid w-full grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    style:max-height={`${position.maxHeight}px`}
    bind:this={panel}
  >
    <header class="flex items-start justify-between gap-3 px-3.5 pt-3.5 pb-2.5">
      <div class="min-w-0">
        <h2 id="model-thinking-picker-title" class="text-sm font-medium text-foreground">
          {visibilityMode ? "Manage visible models" : "Select model & thinking"}
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {visibilityMode ? "Choose which models appear in Desktop model pickers." : selectionDescription}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={applying || savingVisibility}
          onclick={toggleVisibilityMode}
        >{visibilityMode ? "Select" : "Manage"}</button>
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          aria-label="Close model and thinking picker"
          onclick={() => closePopup()}
        ><X class="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </header>

    <label class="px-3 pb-2.5">
      <span class="sr-only">Search models</span>
      <input
        class="h-[34px] w-full rounded-md border border-input bg-background px-2.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
        bind:this={search}
        bind:value={query}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        placeholder="Search models…"
        aria-controls="model-thinking-models"
        aria-activedescendant={filteredModels[selectedIndex] ? `model-thinking-option-${selectedIndex}` : undefined}
      />
    </label>

    <div id="model-thinking-models" class="min-h-0 overflow-y-auto border-t border-border/60 p-1.5" role="listbox" aria-label="Models">
      {#each filteredModels as model, index (model.ref)}
        <button
          class={[
            "grid w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            visibilityMode ? "grid-cols-[22px_16px_minmax(0,1fr)_auto]" : "grid-cols-[16px_minmax(0,1fr)_auto]",
            (!visibilityMode && model.ref === selectedModelRef) || (visibilityMode && index === selectedIndex) ? "bg-panel-selected" : "",
          ]}
          type="button"
          role="option"
          id={`model-thinking-option-${index}`}
          tabindex="-1"
          disabled={disabled || applying || savingVisibility}
          aria-selected={visibilityMode ? index === selectedIndex : model.ref === selectedModelRef}
          data-model-ref={model.ref}
          onmouseenter={() => selectedIndex = index}
          onkeydown={(event) => handleModelKeydown(event)}
          onclick={() => {
            selectedIndex = index;
            if (visibilityMode) void toggleModelVisibility(model);
            else stageModel(model);
          }}
        >
          {#if visibilityMode}
            {#if modelIsVisible(model)}<Check class="h-4 w-4 text-primary" aria-hidden="true" />{:else}<span class="h-3.5 w-3.5 rounded-sm border border-muted-foreground/50" aria-hidden="true"></span>{/if}
          {/if}
          <ModelProviderIcon provider={model.provider} />
          <span class="min-w-0">
            <strong class={["block truncate font-mono text-xs font-medium", modelDisplayToneClass(model.tone)]}>{model.ref}</strong>
            <small class="mt-0.5 block truncate text-xs text-muted-foreground">{model.name}</small>
          </span>
          {#if model.current || (defaultSelection?.kind === "auto" && model.ref === AUTO_MODEL_REF) || (defaultSelection?.kind === "model" && defaultSelection.modelRef === model.ref)}
            <span class="shrink-0 text-xs font-medium text-muted-foreground">
              {#if visibilityMode && model.current}current · required
              {:else if model.current && ((defaultSelection?.kind === "auto" && model.ref === AUTO_MODEL_REF) || (defaultSelection?.kind === "model" && defaultSelection.modelRef === model.ref))}current · default
              {:else if model.current}current
              {:else}default{/if}
            </span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-8 text-center text-xs text-muted-foreground">No matching models</p>
      {/each}
    </div>

    {#if !visibilityMode}<div class="border-t border-border px-3.5 py-3">
      <div class="mb-2 flex min-w-0 items-baseline justify-between gap-3">
        <span class="text-xs font-medium text-foreground">Thinking</span>
        {#if selectedAuto}
          <span class="truncate text-xs text-muted-foreground">Chosen by routing tier</span>
        {:else if selectedModel}
          <span class="truncate text-xs text-muted-foreground">{selectedModel.name}</span>
        {/if}
      </div>
      {#if selectedAuto}
        <p class="text-xs leading-4 text-muted-foreground">The first prompt selects a semantic tier, target model, and tier thinking level before the session is created.</p>
      {:else}<div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Thinking level">
        {#each selectedModel?.thinkingLevels ?? ["off"] as level (level)}
          <button
            class={[
              "h-7 rounded-sm border px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              selectedThinking === level ? "border-input bg-panel-selected" : "border-transparent bg-transparent",
              modelDisplayToneClass(thinkingLevelTone(level, selectedModel?.thinkingLevels ?? ["off"])),
            ]}
            type="button"
            role="radio"
            disabled={disabled || applying || savingVisibility}
            aria-checked={selectedThinking === level}
            data-thinking-level={level}
            tabindex={selectedThinking === level ? 0 : -1}
            onclick={() => stageThinking(level)}
            onkeydown={handleThinkingKeydown}
          >{level}</button>
        {/each}
      </div>{/if}
    </div>{/if}

    <footer class="flex min-w-0 items-center justify-end gap-3 border-t border-border/60 px-3.5 py-2.5">
      {#if visibilityMode}
        <p class="mr-auto min-w-0 truncate text-xs text-muted-foreground">
          Changes save immediately · Shift+Tab returns to selection
        </p>
      {/if}
      <div class="flex shrink-0 items-center gap-1.5">
        {#if visibilityMode}<button
          class="h-7 rounded-md px-2.5 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={disabled || applying || savingVisibility}
          onclick={() => void clearVisibleModels()}
        >Clear all</button>{/if}
        {#if !visibilityMode && onSetDefault}<button
          class="h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={disabled || applying || savingDefault || !selectedModel || selectedIsDefault}
          onclick={() => void setDefaultSelection()}
        >{savingDefault ? "Saving…" : selectedIsDefault ? "Default" : "Set default"}</button>{/if}
        <button
          class="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          onclick={() => closePopup()}
        >{visibilityMode ? "Done" : "Cancel"}</button>
        {#if !visibilityMode}<button
          class="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={disabled || applying || !selectedModel}
          onclick={() => void applySelection()}
        >{applying ? "Applying…" : "Apply"}</button>{/if}
      </div>
    </footer>

    {#if applyError}
      <p class="border-t border-destructive/30 bg-destructive/5 px-3.5 py-2 text-xs text-destructive" role="alert">{applyError}</p>
    {/if}
  </div>
</dialog>
