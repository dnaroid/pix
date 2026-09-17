<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import { projectDocumentLabel } from "../lib/project-documents";

  let {
    choices,
    query = $bindable(""),
    searchInput = $bindable<HTMLInputElement | null>(null),
    onClose,
    onChoose,
  }: {
    choices: string[];
    query: string;
    searchInput: HTMLInputElement | null;
    onClose: () => void;
    onChoose: (plan: string) => void;
  } = $props();
</script>

<div
  class="absolute top-12 right-2 left-14 z-40 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
  role="dialog"
  aria-label="Choose plan"
>
  <div class="flex h-9 items-center gap-2 border-b border-border px-2.5">
    <strong class="min-w-0 flex-1 truncate text-xs font-semibold">Choose plan</strong>
    <button
      class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      title="Close plan selector"
      aria-label="Close plan selector"
      onclick={onClose}
    ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </div>

  <div class="border-b border-border p-2">
    <div class="relative">
      <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        bind:this={searchInput}
        class="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
        type="search"
        placeholder="Find plan…"
        bind:value={query}
        autocomplete="off"
        spellcheck="false"
      />
    </div>
  </div>

  <div class="max-h-72 overflow-y-auto p-1.5">
    {#if choices.length === 0}
      <div class="px-2 py-5 text-center text-xs text-muted-foreground">No matching plans</div>
    {:else}
      {#each choices as plan (plan)}
        <button
          class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          title={plan}
          onclick={() => onChoose(plan)}
        >
          <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{projectDocumentLabel(plan)}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>
