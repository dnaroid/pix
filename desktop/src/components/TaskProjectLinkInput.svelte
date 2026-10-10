<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Plus from "@lucide/svelte/icons/plus";
  import { tick } from "svelte";

  let {
    value = $bindable(""),
    suggestions = [],
    disabled = false,
    onAdd,
    onInput = () => {},
  }: {
    value: string;
    suggestions?: readonly string[];
    disabled?: boolean;
    onAdd: () => void;
    onInput?: () => void;
  } = $props();

  const componentId = $props.id();
  const listId = `${componentId}-project-link-suggestions`;
  let root = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let highlighted = $state(0);
  let position = $state({ left: 8, top: 32, width: 240, maxHeight: 200 });
  const matches = $derived.by(() => {
    const query = value.trim().toLocaleLowerCase();
    return [...new Set(suggestions)]
      .filter((path) => !query || path.toLocaleLowerCase().includes(query))
      .slice(0, 10);
  });

  function reposition(): void {
    if (!open || !input) return;
    const rect = input.getBoundingClientRect();
    const below = Math.max(0, window.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const abovePreferred = below < 160 && above > below;
    const maxHeight = Math.max(36, Math.min(230, (abovePreferred ? above : below) - 4));
    const width = Math.max(0, Math.min(rect.width, window.innerWidth - 16));
    position = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: abovePreferred ? rect.top - maxHeight - 4 : rect.bottom + 4,
      width,
      maxHeight,
    };
  }

  function close(): void { open = false; }

  function choose(path: string): void {
    value = path;
    onInput();
    close();
    void tick().then(() => input?.focus());
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (open && matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = matches[highlighted];
      if (open && candidate) choose(candidate);
      else onAdd();
    }
  }

  function outside(event: PointerEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) close();
  }

  function blur(): void {
    queueMicrotask(() => {
      if (open && root && !root.contains(document.activeElement)) close();
    });
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

<svelte:window onpointerdown={outside} />

<div bind:this={root} class="relative flex min-w-0 gap-1" onfocusout={blur}>
  <input
    bind:this={input}
    bind:value
    type="text"
    role="combobox"
    aria-label="Project file path or URL"
    aria-autocomplete="list"
    aria-expanded={open && matches.length > 0}
    aria-controls={open && matches.length ? listId : undefined}
    aria-activedescendant={open && matches[highlighted] ? `${listId}-${highlighted}` : undefined}
    class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    placeholder="docs/specs/… or .pi/artifacts/…"
    maxlength="1024"
    {disabled}
    onfocus={() => { open = true; reposition(); }}
    oninput={() => { highlighted = 0; onInput(); reposition(); }}
    onkeydown={keydown}
    autocomplete="off"
    spellcheck="false"
  />
  <button
    type="button"
    class="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
    aria-label="Add linked file"
    title="Add linked file"
    {disabled}
    onclick={onAdd}
  ><Plus class="h-4 w-4" aria-hidden="true" /></button>

  {#if open && matches.length}
    <dialog
      open
      class="fixed z-[70] m-0 max-w-none overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style:left={`${position.left}px`}
      style:top={`${position.top}px`}
      style:width={`${position.width}px`}
      style:max-height={`${position.maxHeight}px`}
      aria-label="Suggested project files"
    >
      <div id={listId} role="listbox" aria-label="Suggested project files">
        {#each matches as path, index (path)}
          <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={path === value}
            tabindex="-1"
            class={[
              "flex min-h-8 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
              index === highlighted ? "bg-panel-selected" : "",
            ]}
            onmouseenter={() => highlighted = index}
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => choose(path)}
          ><FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span class="min-w-0 truncate" title={path}>{path}</span></button>
        {/each}
      </div>
    </dialog>
  {/if}
</div>
