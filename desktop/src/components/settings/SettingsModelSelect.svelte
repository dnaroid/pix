<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Search from "@lucide/svelte/icons/search";
  import { tick } from "svelte";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import {
    searchSettingsModelOptions,
    settingsModelSearchOptions,
    type SettingsModelSearchOption,
  } from "../../lib/settings-model-search";

  let {
    value,
    models = [],
    options,
    onChange,
    ariaLabel = "Model",
    emptyLabel,
    disabled = false,
  }: {
    value: string;
    models?: readonly ModelThinkingModel[];
    options?: readonly SettingsModelSearchOption[];
    onChange: (value: string) => void;
    ariaLabel?: string;
    emptyLabel?: string;
    disabled?: boolean;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);

  const catalogOptions = $derived(options ?? settingsModelSearchOptions(models));
  const configuredOnly = $derived(value.length > 0 && !catalogOptions.some((option) => option.value === value));
  const choices = $derived.by<SettingsModelSearchOption[]>(() => {
    const next: SettingsModelSearchOption[] = [];
    if (emptyLabel) next.push({ value: "", label: emptyLabel });
    if (configuredOnly) next.push({ value, label: `${value} · Configured`, description: "Configured value" });
    next.push(...catalogOptions);
    return next;
  });
  const filteredOptions = $derived(searchSettingsModelOptions(choices, query));
  const currentOption = $derived(choices.find((option) => option.value === value));
  const unavailable = $derived(catalogOptions.length === 0 && !value && !emptyLabel);
  const triggerDisabled = $derived(disabled || unavailable);
  const triggerLabel = $derived(currentOption?.label ?? (value || emptyLabel || "Model catalog unavailable"));

  function show(): void {
    if (triggerDisabled) return;
    open = true;
    query = "";
    selectedIndex = Math.max(0, choices.findIndex((option) => option.value === value));
    void tick().then(() => search?.focus());
  }

  function close(restoreFocus = false): void {
    open = false;
    query = "";
    if (restoreFocus) void tick().then(() => trigger?.focus());
  }

  function choose(option: SettingsModelSearchOption): void {
    onChange(option.value);
    close(true);
  }

  function handleWindowPointerDown(event: PointerEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    close();
  }

  function handleFocusOut(event: FocusEvent): void {
    if (!open || !root) return;
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    close();
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    show();
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (filteredOptions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + direction + filteredOptions.length) % filteredOptions.length;
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectedIndex = event.key === "Home" ? 0 : filteredOptions.length - 1;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[selectedIndex];
      if (option) choose(option);
    }
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div bind:this={root} class="relative" onfocusout={handleFocusOut}>
  <button
    bind:this={trigger}
    class="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-input bg-panel-strong py-0 pr-2 pl-2 text-left text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-55"
    type="button"
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? "settings-model-options" : undefined}
    disabled={triggerDisabled}
    onclick={() => open ? close() : show()}
    onkeydown={handleTriggerKeydown}
  >
    <span class="min-w-0 flex-1 truncate">{triggerLabel}</span>
    <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  </button>

  {#if open}
    <div class="mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div class="relative border-b border-border p-1.5">
        <Search class="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          bind:this={search}
          class="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
          type="search"
          role="combobox"
          aria-label={`Search ${ariaLabel.toLowerCase()}`}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="settings-model-options"
          aria-activedescendant={filteredOptions[selectedIndex] ? `settings-model-option-${selectedIndex}` : undefined}
          placeholder="Filter models…"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          oninput={() => selectedIndex = 0}
          onkeydown={handleSearchKeydown}
        />
      </div>
      <div id="settings-model-options" class="max-h-56 overflow-y-auto p-1" role="listbox" aria-label={ariaLabel}>
        {#each filteredOptions as option, index (option.value)}
          <button
            class={[
              "grid min-h-8 w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              index === selectedIndex && "bg-accent text-accent-foreground",
            ]}
            type="button"
            role="option"
            id={`settings-model-option-${index}`}
            aria-selected={option.value === value}
            tabindex="-1"
            onmouseenter={() => selectedIndex = index}
            onclick={() => choose(option)}
          >
            {#if option.value === value}<Check class="h-3.5 w-3.5 text-primary" aria-hidden="true" />{:else}<span aria-hidden="true"></span>{/if}
            <span class="min-w-0">
              <strong class="block truncate text-xs font-medium">{option.label}</strong>
              {#if option.description}<small class="block truncate font-mono text-xs text-muted-foreground">{option.description}</small>{/if}
            </span>
          </button>
        {:else}
          <p class="px-2 py-4 text-center text-xs text-muted-foreground">No matching models</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
