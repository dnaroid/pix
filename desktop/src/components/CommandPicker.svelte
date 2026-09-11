<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import type { CommandPickerState } from "../lib/command-interactions";
  import { fuzzySearch } from "../lib/fuzzy";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { modelDisplayToneClass } from "../lib/model-display";

  let {
    picker,
    onSelect,
    onClose,
  }: {
    picker: CommandPickerState;
    onSelect: (value: string) => void;
    onClose: () => void;
  } = $props();

  let panel = $state<HTMLElement | null>(null);
  let dialogElement = $state<HTMLDialogElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let query = $state("");
  let selectedIndex = $state(0);
  const filteredItems = $derived(fuzzySearch(
    picker.items.map((item) => ({
      value: item,
      label: item.label,
      aliases: [item.value, ...(item.aliases ?? [])],
      keywords: [item.description ?? "", ...(item.keywords ?? [])],
    })),
    query,
  ).map((match) => match.value));

  $effect(() => {
    query;
    selectedIndex = 0;
  });

  $effect(() => {
    const item = filteredItems[selectedIndex];
    if (!item) return;
    void tick().then(() => {
      panel?.querySelector<HTMLElement>(`[data-command-value="${CSS.escape(item.id ?? item.value)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  onMount(() => {
    query = picker.initialQuery ?? "";
    if (!dialogElement) return;
    return activateModalDialog(dialogElement, () => search);
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.target !== search) return;
    if (filteredItems.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + direction + filteredItems.length) % filteredItems.length;
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectedIndex = event.key === "Home" ? 0 : filteredItems.length - 1;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filteredItems[selectedIndex];
      if (item) onSelect(item.value);
    }
  }

  function optionId(index: number): string {
    return `command-picker-option-${index}`;
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-40 m-auto h-screen max-h-none w-screen max-w-none place-items-center border-0 bg-transparent p-6 text-foreground backdrop:bg-overlay open:grid"
  aria-labelledby="command-picker-title"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  oncancel={(event) => { event.preventDefault(); onClose(); }}
>
  <div
    class="grid max-h-[min(560px,calc(100vh-48px))] w-[min(540px,100%)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
    bind:this={panel}
  >
    <header class="flex items-center justify-between gap-3 px-3.5 pt-3.5 pb-2.5">
      <div>
        <span class="font-mono text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">
          {picker.command === "commands" ? "Commands" : `/${picker.command}`}
        </span>
        <h2 id="command-picker-title" class="mt-1 text-sm font-medium text-foreground">{picker.title}</h2>
      </div>
      <button
        class="grid h-7 w-7 cursor-pointer place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        type="button"
        aria-label="Close command picker"
        onclick={onClose}
      ><X class="h-4 w-4" aria-hidden="true" /></button>
    </header>

    <label class="px-3 pb-2.5">
      <span class="sr-only">{picker.placeholder}</span>
      <input
        class="h-[34px] w-full rounded-md border border-input bg-background px-2.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
        bind:this={search}
        bind:value={query}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        placeholder={picker.placeholder}
        aria-controls="command-picker-options"
        aria-activedescendant={filteredItems[selectedIndex] ? optionId(selectedIndex) : undefined}
      />
    </label>

    <div id="command-picker-options" class="min-h-0 overflow-y-auto border-t border-border/60 p-1.5" role="listbox" aria-label={picker.title}>
      {#each filteredItems as item, index (item.id ?? `${index}:${item.value}`)}
        <button
          class={[
            "grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            index === selectedIndex && "bg-accent text-accent-foreground",
          ]}
          type="button"
          role="option"
          id={optionId(index)}
          aria-selected={index === selectedIndex}
          tabindex="-1"
          data-command-value={item.id ?? item.value}
          onmouseenter={() => selectedIndex = index}
          onclick={() => onSelect(item.value)}
        >
          {#if item.current}<Check class="h-4 w-4 text-primary" aria-hidden="true" />{:else}<span aria-hidden="true"></span>{/if}
          <span class="min-w-0">
            <strong class={[
              "block truncate text-xs font-medium",
              picker.command === "model" && "font-mono",
              modelDisplayToneClass(item.tone),
            ]}>{item.label}</strong>
            {#if item.description}<small class={["mt-0.5 block truncate text-[11px] text-muted-foreground", picker.command !== "commands" && "font-mono"]}>{item.description}</small>{/if}
          </span>
          {#if item.shortcut}
            <kbd class="rounded-sm border border-border/70 bg-panel px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">{item.shortcut}</kbd>
          {:else}
            <span aria-hidden="true"></span>
          {/if}
        </button>
      {:else}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">{picker.emptyText}</p>
      {/each}
    </div>
  </div>
</dialog>
