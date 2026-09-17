<script lang="ts">
  import type { SlashCommandMatch } from "../lib/slash-commands";

  let {
    matches,
    selectedIndex,
    listbox = $bindable<HTMLDivElement | undefined>(undefined),
    listboxId,
    onSelectIndex,
    onChoose,
  }: {
    matches: readonly SlashCommandMatch[];
    selectedIndex: number;
    listbox: HTMLDivElement | undefined;
    listboxId: string;
    onSelectIndex: (index: number) => void;
    onChoose: (match: SlashCommandMatch) => void;
  } = $props();
</script>

<div
  bind:this={listbox}
  class="absolute right-0 bottom-[calc(100%+0.375rem)] left-0 z-30 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
  id={listboxId}
  role="listbox"
  aria-label="Slash commands"
>
  {#each matches as match, index (`${match.command.name}:${index}`)}
    <button
      class={[
        "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
        index === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      ]}
      type="button"
      id={`prompt-slash-command-${index}`}
      data-slash-command-index={index}
      role="option"
      aria-selected={index === selectedIndex}
      tabindex="-1"
      onmousedown={(event) => event.preventDefault()}
      onmouseenter={() => onSelectIndex(index)}
      onclick={() => onChoose(match)}
    >
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-baseline gap-2">
          <span class="shrink-0 font-mono text-xs font-semibold text-foreground">/{match.command.name}</span>
          {#if match.inputHint}
            <span class="truncate font-mono text-xs text-muted-foreground">{match.inputHint}</span>
          {/if}
        </span>
        <span class="mt-0.5 block truncate text-xs text-muted-foreground">{match.command.description}</span>
      </span>
      {#if match.source}
        <span class="mt-0.5 shrink-0 rounded border border-border/80 px-1.5 py-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{match.source}</span>
      {/if}
    </button>
  {/each}
</div>
