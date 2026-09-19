<script lang="ts">
  let {
    value,
    onChange,
    disabled = false,
  }: {
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
  } = $props();
</script>

<button
  class="inline-flex h-7 min-w-20 cursor-pointer items-center gap-2 rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
  type="button"
  role="switch"
  aria-checked={value}
  {disabled}
  onclick={() => onChange(!value)}
>
  <span class={[
    "relative h-4 w-7 shrink-0 rounded-full border transition-colors",
    value ? "border-primary bg-primary" : "border-border bg-muted",
  ]} aria-hidden="true">
    <span class={[
      "absolute top-0.5 h-2.5 w-2.5 rounded-full bg-primary-foreground transition-[left]",
      value ? "left-3" : "left-0.5",
    ]}></span>
  </span>
  <span>{value ? "On" : "Off"}</span>
</button>
