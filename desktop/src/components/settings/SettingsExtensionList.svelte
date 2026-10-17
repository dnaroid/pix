<script lang="ts">
  let { value, label, onChange }: { value: string[]; label: string; onChange: (value: string[]) => void } = $props();
  let text = $state("");
  const split = (input: string) => input.split(/[\s,]+/).filter(Boolean);
  $effect(() => {
    if (JSON.stringify(split(text)) !== JSON.stringify(value)) text = value.join(", ");
  });
</script>

<textarea aria-label={label} rows={4} value={text} oninput={(event) => {
  text = event.currentTarget.value;
  onChange(split(text));
}} spellcheck="false" class="w-full resize-none rounded-md border border-input bg-panel-strong px-2 py-1 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"></textarea>
