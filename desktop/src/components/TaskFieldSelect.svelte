<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Search from "@lucide/svelte/icons/search";
  import { tick } from "svelte";

  export type TaskFieldOption = { value: string; label: string; description?: string };

  let {
    value,
    options,
    onChange,
    ariaLabel,
    disabled = false,
    searchable = false,
    compact = false,
  }: {
    value: string;
    options: readonly TaskFieldOption[];
    onChange: (value: string) => void;
    ariaLabel: string;
    disabled?: boolean;
    searchable?: boolean;
    compact?: boolean;
  } = $props();

  const id = $props.id();
  const optionsId = `${id}-options`;
  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  let popupPosition = $state({ left: 8, top: 32, width: 200, maxHeight: 240 });
  const currentOption = $derived(options.find((option) => option.value === value));
  const filteredOptions = $derived.by(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? options.filter((option) => `${option.label} ${option.value} ${option.description ?? ""}`.toLocaleLowerCase().includes(term))
      : options;
  });

  function reposition(): void {
    if (!open || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) { close(); return; }
    const below = Math.max(0, window.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const useAbove = below < 200 && above > below;
    const maxHeight = Math.max(40, Math.min(280, (useAbove ? above : below) - 4));
    const width = Math.max(0, Math.min(rect.width, window.innerWidth - 16));
    popupPosition = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: useAbove ? rect.top - maxHeight - 4 : rect.bottom + 4,
      width,
      maxHeight,
    };
  }

  function show(): void {
    if (disabled || open) return;
    query = "";
    selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
    open = true;
    reposition();
    void tick().then(() => {
      if (!open) return;
      if (searchable) search?.focus();
      else focusOption();
    });
  }

  function close(restoreFocus = false): void {
    open = false;
    query = "";
    if (restoreFocus) void tick().then(() => trigger?.focus());
  }

  function choose(option: TaskFieldOption): void {
    onChange(option.value);
    close(true);
  }

  function focusOption(): void {
    const option = root?.querySelector<HTMLButtonElement>(`[data-task-select-option="${selectedIndex}"]`);
    option?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!filteredOptions.length) return;
      event.preventDefault();
      selectedIndex = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + filteredOptions.length) % filteredOptions.length;
      if (!searchable) void tick().then(focusOption);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!filteredOptions.length) return;
      event.preventDefault();
      selectedIndex = event.key === "Home" ? 0 : filteredOptions.length - 1;
      if (!searchable) void tick().then(focusOption);
      return;
    }
    if (event.key === "Enter" && (event.target === search || event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      const option = filteredOptions[selectedIndex];
      if (option) choose(option);
    }
  }

  function handleOutsidePointerDown(event: PointerEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    close();
  }

  function handleFocusOut(): void {
    if (!open) return;
    queueMicrotask(() => {
      if (open && root && !root.contains(document.activeElement)) close();
    });
  }

  function handlePopupPointerDown(event: PointerEvent): void {
    // In WebKit an unfocused button press can blur search to document.body
    // before click. Keep the option focused so focusout cannot close early.
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-task-select-option]") : null;
    if (button) button.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  });
</script>

<svelte:window onpointerdown={handleOutsidePointerDown} />

<div bind:this={root} class="relative min-w-0" onfocusout={handleFocusOut}>
  <button
    bind:this={trigger}
    type="button"
    class={[
      "flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs text-foreground transition-colors hover:border-ring/55 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-45",
      compact ? "h-7" : "h-9",
    ]}
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? optionsId : undefined}
    disabled={disabled}
    onclick={() => open ? close() : show()}
    onkeydown={(event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        show();
      }
    }}
  >
    <span class="min-w-0 truncate">{currentOption?.label ?? value}</span>
    <ChevronDown class={["h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "rotate-0"]} aria-hidden="true" />
  </button>

  {#if open}
    <dialog
      open
      class="fixed z-[70] m-0 max-w-none overflow-hidden rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-lg"
      style:left={`${popupPosition.left}px`}
      style:top={`${popupPosition.top}px`}
      style:width={`${popupPosition.width}px`}
      style:max-height={`${popupPosition.maxHeight}px`}
      aria-label={ariaLabel}
      onkeydown={handleKeydown}
      onpointerdown={handlePopupPointerDown}
    >
      {#if searchable}
        <div class="relative border-b border-border p-1.5">
          <Search class="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            bind:this={search}
            type="search"
            role="combobox"
            aria-label={`Search ${ariaLabel.toLowerCase()}`}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={optionsId}
            aria-activedescendant={filteredOptions[selectedIndex] ? `${optionsId}-${selectedIndex}` : undefined}
            class="h-8 w-full rounded-md border border-input bg-background pr-2 pl-7 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
            placeholder="Search tasks…"
            bind:value={query}
            oninput={() => selectedIndex = 0}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      {/if}
      <div id={optionsId} class="overflow-y-auto p-1" style:max-height={`${popupPosition.maxHeight - (searchable ? 48 : 0)}px`} role="listbox" aria-label={ariaLabel}>
        {#each filteredOptions as option, index (option.value)}
          <button
            data-task-select-option={index}
            class={[
              "flex min-h-8 w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              index === selectedIndex ? "bg-panel-selected" : "",
            ]}
            type="button"
            role="option"
            id={`${optionsId}-${index}`}
            tabindex={searchable ? -1 : index === selectedIndex ? 0 : -1}
            aria-selected={option.value === value}
            onmouseenter={() => selectedIndex = index}
            onclick={() => choose(option)}
          >
            {#if option.value === value}<Check class="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />{:else}<span class="w-3.5 shrink-0" aria-hidden="true"></span>{/if}
            <span class="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
          </button>
        {:else}
          <p class="px-2 py-4 text-center text-xs text-muted-foreground">No matching tasks</p>
        {/each}
      </div>
    </dialog>
  {/if}
</div>
