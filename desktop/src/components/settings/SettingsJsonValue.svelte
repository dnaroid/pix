<script lang="ts">
  let {
    value,
    onChange,
    placeholder = "{}",
    rows = 6,
  }: {
    value: unknown;
    onChange: (value: unknown) => void;
    placeholder?: string;
    rows?: number;
  } = $props();

  function formatted(): string {
    return value === undefined ? "" : JSON.stringify(value, null, 2);
  }
</script>

<textarea
  class="w-full resize-none rounded-md border border-code-border bg-code px-2 py-1.5 font-mono text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground/65 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
  value={formatted()}
  {placeholder}
  {rows}
  spellcheck="false"
  onchange={(event) => {
    const target = event.currentTarget as HTMLTextAreaElement;
    const raw = target.value.trim();
    if (!raw) {
      target.setCustomValidity("");
      onChange(undefined);
      return;
    }
    try {
      onChange(JSON.parse(raw));
      target.setCustomValidity("");
    } catch {
      target.setCustomValidity("Enter valid JSON. Use Advanced JSONC for comments.");
      target.reportValidity();
    }
  }}
></textarea>
<p class="mt-1 text-xs leading-4 text-muted-foreground">Structured value. Use Advanced JSONC when comments inside this value must be preserved.</p>
