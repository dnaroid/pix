<script lang="ts">
  let {
    value,
    onChange,
    min,
    max,
    step = "any",
    placeholder = "",
  }: {
    value: number | undefined;
    onChange: (value: number | undefined) => void;
    min?: number;
    max?: number;
    step?: number | "any";
    placeholder?: string;
  } = $props();
</script>

<input
  class="h-7 w-full appearance-none rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30"
  type="number"
  value={value ?? ""}
  {min}
  {max}
  {step}
  {placeholder}
  oninput={(event) => {
    const raw = (event.currentTarget as HTMLInputElement).value;
    if (raw === "") onChange(undefined);
    else if (Number.isFinite(Number(raw))) onChange(Number(raw));
  }}
/>
