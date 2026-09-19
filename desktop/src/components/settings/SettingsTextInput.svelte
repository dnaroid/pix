<script lang="ts">
  let {
    value,
    onChange,
    placeholder = "",
    type = "text",
    sensitive = false,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: "text" | "password";
    sensitive?: boolean;
  } = $props();
</script>

<input
  class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30"
  {type}
  {value}
  {placeholder}
  autocomplete={sensitive || type === "password" ? "off" : "off"}
  spellcheck="false"
  oninput={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
/>
