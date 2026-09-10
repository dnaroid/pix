<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { fuzzySearch } from "../lib/fuzzy";
  import { modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import {
    clampThinkingLevel,
    modelThinkingConfigState,
    type ModelThinkingModel,
  } from "../lib/model-thinking";

  let {
    configOptions,
    disabled = false,
    onApply,
    onClose,
  }: {
    configOptions: readonly SessionConfigOption[];
    disabled?: boolean;
    onApply: (modelRef: string, thinkingLevel: string) => void | Promise<void>;
    onClose: () => void;
  } = $props();

  const config = $derived(modelThinkingConfigState(configOptions));
  let panel = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let query = $state("");
  let selectedModelRef = $state("");
  let selectedThinking = $state("off");
  let selectedIndex = $state(0);
  let applying = $state(false);
  let applyError = $state("");
  let initialized = false;
  let previousFocus: HTMLElement | null = null;
  const thinkingByModel = new Map<string, string>();

  const filteredModels = $derived(fuzzySearch(
    config.models.map((model) => ({
      value: model,
      label: model.ref,
      aliases: [model.modelId, model.name, model.provider],
      keywords: [model.name, `${model.provider} ${model.modelId}`],
    })),
    query,
  ).map((match) => match.value));
  const selectedModel = $derived(
    config.models.find((model) => model.ref === selectedModelRef) ?? config.currentModel ?? config.models[0],
  );
  const dirty = $derived(
    !!selectedModel
      && (selectedModel.ref !== config.currentModel?.ref || selectedThinking !== config.currentThinking),
  );

  onMount(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialModel = config.currentModel ?? config.models[0];
    if (initialModel) {
      selectedModelRef = initialModel.ref;
      selectedThinking = clampThinkingLevel(config.currentThinking, initialModel.thinkingLevels);
      thinkingByModel.set(initialModel.ref, selectedThinking);
    }
    initialized = true;
    search?.focus();
    return () => previousFocus?.focus();
  });

  $effect(() => {
    query;
    if (!initialized) return;
    selectedIndex = 0;
    const first = filteredModels[0];
    if (first) stageModel(first);
  });

  $effect(() => {
    const model = filteredModels[selectedIndex];
    if (!model) return;
    void tick().then(() => {
      panel?.querySelector<HTMLElement>(`[data-model-ref="${CSS.escape(model.ref)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  function stageModel(model: ModelThinkingModel): void {
    if (selectedModelRef) thinkingByModel.set(selectedModelRef, selectedThinking);
    selectedModelRef = model.ref;
    selectedThinking = thinkingByModel.get(model.ref)
      ?? clampThinkingLevel(config.currentThinking, model.thinkingLevels);
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
    if (model) stageModel(model);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (applying) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.target === search && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveModel(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.target === search && event.key === "Enter") {
      event.preventDefault();
      void applySelection();
      return;
    }
    if (event.target === search && event.key === "Tab" && !event.shiftKey) {
      const level = selectedThinking;
      event.preventDefault();
      void tick().then(() => {
        panel?.querySelector<HTMLButtonElement>(`[data-thinking-level="${CSS.escape(level)}"]`)?.focus();
      });
    }
  }

  function handleThinkingKeydown(event: KeyboardEvent, index: number): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void applySelection();
      return;
    }
    if (!selectedModel || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const levels = selectedModel.thinkingLevels;
    const nextIndex = (index + (event.key === "ArrowRight" ? 1 : -1) + levels.length) % levels.length;
    const next = levels[nextIndex];
    if (!next) return;
    stageThinking(next);
    void tick().then(() => {
      panel?.querySelector<HTMLButtonElement>(`[data-thinking-level="${CSS.escape(next)}"]`)?.focus();
    });
  }

  async function applySelection(): Promise<void> {
    if (!selectedModel || !dirty || disabled || applying) return;
    applying = true;
    applyError = "";
    try {
      await onApply(selectedModel.ref, selectedThinking);
      onClose();
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      applying = false;
    }
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (!applying && event.target === event.currentTarget) onClose();
  }
</script>

<div
  class="fixed inset-0 z-40 grid place-items-center bg-overlay p-6"
  role="presentation"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div
    class="grid max-h-[min(660px,calc(100vh-48px))] w-[min(620px,100%)] grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
    role="dialog"
    aria-modal="true"
    aria-labelledby="model-thinking-picker-title"
    bind:this={panel}
  >
    <header class="flex items-start justify-between gap-3 px-3.5 pt-3.5 pb-2.5">
      <div class="min-w-0">
        <h2 id="model-thinking-picker-title" class="text-sm font-medium text-foreground">Select model &amp; thinking</h2>
        <p class="mt-0.5 text-[11px] text-muted-foreground">Choose both, then apply them together to this session.</p>
      </div>
      <button
        class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        aria-label="Close model and thinking picker"
        disabled={applying}
        onclick={onClose}
      ><X class="h-4 w-4" aria-hidden="true" /></button>
    </header>

    <label class="px-3 pb-2.5">
      <span class="sr-only">Search models</span>
      <input
        class="h-[34px] w-full rounded-md border border-input bg-background px-2.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
        bind:this={search}
        bind:value={query}
        type="search"
        placeholder="Search models…"
        aria-controls="model-thinking-models"
      />
    </label>

    <div id="model-thinking-models" class="min-h-0 overflow-y-auto border-t border-border/60 p-1.5" role="listbox" aria-label="Models">
      {#each filteredModels as model, index (model.ref)}
        <button
          class={[
            "grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            model.ref === selectedModelRef && "bg-panel-selected",
          ]}
          type="button"
          role="option"
          aria-selected={model.ref === selectedModelRef}
          data-model-ref={model.ref}
          onmouseenter={() => selectedIndex = index}
          onclick={() => {
            selectedIndex = index;
            stageModel(model);
          }}
        >
          {#if model.ref === selectedModelRef}<Check class="h-4 w-4 text-primary" aria-hidden="true" />{:else}<span aria-hidden="true"></span>{/if}
          <span class="min-w-0">
            <strong class={["block truncate font-mono text-xs font-medium", modelDisplayToneClass(model.tone)]}>{model.ref}</strong>
            <small class="mt-0.5 block truncate text-[11px] text-muted-foreground">{model.name}</small>
          </span>
          {#if model.current}
            <span class="shrink-0 text-[10px] font-medium text-muted-foreground">current</span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-8 text-center text-xs text-muted-foreground">No matching models</p>
      {/each}
    </div>

    <div class="border-t border-border px-3.5 py-3">
      <div class="mb-2 flex min-w-0 items-baseline justify-between gap-3">
        <span class="text-xs font-medium text-foreground">Thinking</span>
        {#if selectedModel}<span class="truncate text-[11px] text-muted-foreground">{selectedModel.name}</span>{/if}
      </div>
      <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Thinking level">
        {#each selectedModel?.thinkingLevels ?? ["off"] as level, index (level)}
          <button
            class={[
              "h-7 cursor-pointer rounded-sm border px-2.5 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              selectedThinking === level ? "border-input bg-panel-selected" : "border-transparent bg-transparent",
              modelDisplayToneClass(thinkingLevelTone(level, selectedModel?.thinkingLevels ?? ["off"])),
            ]}
            type="button"
            role="radio"
            aria-checked={selectedThinking === level}
            data-thinking-level={level}
            tabindex={selectedThinking === level ? 0 : -1}
            onclick={() => stageThinking(level)}
            onkeydown={(event) => handleThinkingKeydown(event, index)}
          >{level}</button>
        {/each}
      </div>
    </div>

    <footer class="flex min-w-0 items-center justify-between gap-3 border-t border-border/60 px-3.5 py-2.5">
      <p class="min-w-0 truncate text-[11px] text-muted-foreground">
        {#if selectedModel}
          <span class={modelDisplayToneClass(selectedModel.tone)}>{selectedModel.name}</span>
          <span class="px-1 text-muted-foreground/70">·</span>
          <span class={modelDisplayToneClass(thinkingLevelTone(selectedThinking, selectedModel.thinkingLevels))}>{selectedThinking}</span>
        {/if}
      </p>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          class="h-7 cursor-pointer rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={applying}
          onclick={onClose}
        >Cancel</button>
        <button
          class="h-7 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={!dirty || disabled || applying || !selectedModel}
          onclick={() => void applySelection()}
        >{applying ? "Applying…" : "Apply"}</button>
      </div>
    </footer>

    {#if applyError}
      <p class="border-t border-destructive/30 bg-destructive/5 px-3.5 py-2 text-[11px] text-destructive" role="alert">{applyError}</p>
    {/if}
  </div>
</div>
