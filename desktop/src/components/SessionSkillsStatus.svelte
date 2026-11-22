<script lang="ts">
  import GraduationCap from "@lucide/svelte/icons/graduation-cap";
  import StatusBarPopover from "./StatusBarPopover.svelte";

  let { findSkills }: { findSkills: () => string[] } = $props();
  let names = $state<string[]>([]);
</script>

<StatusBarPopover label="Loaded skills" onOpen={() => { names = findSkills(); }}>
  {#snippet trigger({ open, toggle, id })}
    <button
      class={[
        "flex h-6 items-center rounded-sm bg-transparent px-1.5 transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        open && "bg-chrome-hover",
      ]}
      type="button"
      aria-label="Loaded skills"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      onclick={toggle}
    >
      <GraduationCap class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  {/snippet}

  <div class="rounded-md border border-border bg-popover text-popover-foreground shadow-md">
    <h2 class="border-b border-border px-2.5 py-1.5 text-xs font-semibold">Loaded skills</h2>
    {#if names.length}
      <ul class="px-2.5 py-1.5 font-mono">
        {#each names as name (name)}
          <li class="break-words py-0.5">{name}</li>
        {/each}
      </ul>
      <p class="border-t border-border px-2.5 py-1.5 text-muted-foreground">From loaded chat history</p>
    {:else}
      <p class="px-2.5 py-1.5 text-muted-foreground">No skill loads found in the loaded chat history.</p>
    {/if}
  </div>
</StatusBarPopover>
