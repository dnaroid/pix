<script lang="ts">
  import TaskFieldSelect from "../TaskFieldSelect.svelte";

  export type SettingsSelectOption = { value: string; label: string };

  let {
    value,
    options,
    onChange,
    ariaLabel,
  }: {
    value: string;
    options: readonly SettingsSelectOption[];
    // Controlled value: returning false (rejecting the change) keeps the current value.
    onChange: (value: string) => unknown;
    ariaLabel?: string;
  } = $props();

  // A configured value missing from the catalog stays visible and selectable.
  const resolvedOptions = $derived(
    value.length > 0 && !options.some((option) => option.value === value)
      ? [{ value, label: `${value} · Configured` }, ...options]
      : options,
  );
</script>

<TaskFieldSelect
  {value}
  options={resolvedOptions}
  {onChange}
  ariaLabel={ariaLabel ?? "Select value"}
  size="sm"
  searchable={resolvedOptions.length > 12}
  searchPlaceholder="Search…"
  emptyLabel="No matching options"
/>
