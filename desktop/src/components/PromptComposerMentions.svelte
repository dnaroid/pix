<script lang="ts">
  import File from "@lucide/svelte/icons/file";
  import Folder from "@lucide/svelte/icons/folder";
  import { tick } from "svelte";
  import type { createPromptComposerMentionsController } from "./prompt-composer-mentions-controller.svelte";
  let { controller }: { controller: ReturnType<typeof createPromptComposerMentionsController> } = $props();
  let list: HTMLDivElement | undefined = $state();
  $effect(() => {
    const index = controller.selectedIndex;
    void tick().then(() => list?.querySelector<HTMLElement>(`[data-mention-index="${index}"]`)?.scrollIntoView({ block: "nearest" }));
  });
</script>

{#if controller.open}
  <div class="absolute inset-x-0 bottom-full z-30 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    data-file-mention-popup role="listbox" aria-label="Project files and folders" id="prompt-file-mention-listbox" bind:this={list}>
    {#if controller.matches.length === 0}
      <div role="status" class="px-2 py-2 text-xs text-muted-foreground">{controller.loading ? "Searching project…" : controller.failed ? "File search unavailable. Escape to continue." : "No matching paths. Escape to continue."}</div>
    {/if}
    {#each controller.matches as match, index (match.path)}
      <button type="button" role="option" id={`prompt-file-mention-${index}`} data-mention-index={index}
        aria-selected={index === controller.selectedIndex} tabindex="-1"
        class={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs font-mono ${index === controller.selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
        onpointerdown={(event) => event.preventDefault()}
        onpointermove={() => controller.select(index)} onclick={() => void controller.accept(match)}>
        {#if match.directory}<Folder class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{:else}<File class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{/if}
        <span class="truncate">{match.path}</span>
      </button>
    {/each}
  </div>
{/if}
