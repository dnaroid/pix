<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  let {
    value,
    onChange,
    placeholder = "provider/model",
    addLabel = "Add item",
  }: {
    value: readonly string[];
    onChange: (value: string[]) => void;
    placeholder?: string;
    addLabel?: string;
  } = $props();

  function updateAt(index: number, next: string): void {
    const copy = [...value];
    copy[index] = next;
    onChange(copy);
  }

  function removeAt(index: number): void {
    onChange(value.filter((_item, itemIndex) => itemIndex !== index));
  }
</script>

<div class="space-y-1.5">
  {#each value as item, index (index)}
    <div class="flex items-center gap-1.5">
      <input
        class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30"
        type="text"
        value={item}
        {placeholder}
        autocomplete="off"
        spellcheck="false"
        oninput={(event) => updateAt(index, (event.currentTarget as HTMLInputElement).value)}
      />
      <button
        class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        type="button"
        aria-label={`Remove item ${index + 1}`}
        title="Remove"
        onclick={() => removeAt(index)}
      ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  {/each}
  <button
    class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    type="button"
    onclick={() => onChange([...value, ""])}
  ><Plus class="h-3.5 w-3.5" aria-hidden="true" />{addLabel}</button>
</div>
