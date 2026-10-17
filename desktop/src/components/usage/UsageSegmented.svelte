<script lang="ts" generics="T extends string">
  let { value, options, ariaLabel, onChange }: {
    value: T;
    options: readonly { value: T; label: string }[];
    ariaLabel: string;
    onChange: (value: T) => void;
  } = $props();
</script>

<div class="inline-flex h-6 shrink-0 items-center rounded-sm border border-border bg-panel p-px" role="group" aria-label={ariaLabel}>
  {#each options as option (option.value)}
    <button
      type="button"
      class={["h-full rounded-[3px] px-1.5 text-[11px] leading-none transition-colors motion-reduce:transition-none",
        option.value === value ? "bg-panel-selected font-medium text-foreground" : "text-muted-foreground hover:bg-panel-hover hover:text-foreground"]}
      aria-pressed={option.value === value}
      onclick={() => { if (option.value !== value) onChange(option.value); }}
    >{option.label}</button>
  {/each}
</div>
