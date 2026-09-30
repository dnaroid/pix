<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import Info from "@lucide/svelte/icons/info";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import X from "@lucide/svelte/icons/x";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import {
    TODO_THINKING_LEVEL_OPTIONS,
    todoThinkingOverridePatternKey,
    todoThinkingRangeError,
    type TodoThinkingOverrideRow,
    type TodoThinkingOverrideValue,
  } from "../../lib/todo-thinking-overrides-settings";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";

  const NO_OVERRIDE = "__no_override__";
  const BOUNDS = ["min", "max"] as const;

  let {
    rows,
    models,
    onAdd,
    onRename,
    onLevelChange,
    onRemove,
  }: {
    rows: readonly TodoThinkingOverrideRow[];
    models: readonly ModelThinkingModel[];
    onAdd: (pattern: string, level: TodoThinkingOverrideValue) => void;
    onRename: (row: TodoThinkingOverrideRow, pattern: string) => void;
    onLevelChange: (row: TodoThinkingOverrideRow, level: TodoThinkingOverrideValue) => void;
    onRemove: (row: TodoThinkingOverrideRow) => void;
  } = $props();

  let newPattern = $state("");
  let newMin = $state("low");
  let newMax = $state("high");
  let rowError = $state<{ pattern: string; message: string } | undefined>();
  const newRangeError = $derived(todoThinkingRangeError({ min: newMin, max: newMax }));

  const newPatternKey = $derived(todoThinkingOverridePatternKey(newPattern));
  const duplicateNewPattern = $derived(Boolean(
    newPatternKey && rows.some((row) => todoThinkingOverridePatternKey(row.pattern) === newPatternKey),
  ));
  const canAdd = $derived(Boolean(newPatternKey) && !duplicateNewPattern && !newRangeError);

  function levelValue(row: TodoThinkingOverrideRow, bound: "min" | "max"): string {
    return row.level?.[bound] ?? NO_OVERRIDE;
  }

  function inheritedLabel(row: TodoThinkingOverrideRow): string {
    if (row.level === null) return "Inherited policy disabled";
    if (row.explicit) return "Overrides inherited policy";
    return "Inherited policy";
  }

  function changeLevel(row: TodoThinkingOverrideRow, bound: "min" | "max", raw: string): boolean {
    rowError = undefined;
    if (raw !== NO_OVERRIDE) {
      const range = { ...(row.level ?? { min: raw, max: raw }), [bound]: raw };
      const error = todoThinkingRangeError(range);
      if (error) {
        rowError = { pattern: row.pattern, message: error };
        return false;
      }
      onLevelChange(row, range);
      return true;
    }
    if (row.inherited) onLevelChange(row, null);
    else onRemove(row);
    return true;
  }

  function rowLevelOptions(row: TodoThinkingOverrideRow): Array<{ value: string; label: string }> {
    return [
      ...TODO_THINKING_LEVEL_OPTIONS,
      { value: NO_OVERRIDE, label: row.inherited ? "No override" : "Remove" },
    ];
  }

  function rename(row: TodoThinkingOverrideRow, value: string): void {
    rowError = undefined;
    const next = value.trim();
    const nextKey = todoThinkingOverridePatternKey(next);
    const currentKey = todoThinkingOverridePatternKey(row.pattern);
    if (!nextKey || nextKey === currentKey) {
      return;
    }
    const duplicate = rows.some((candidate) => (
      candidate !== row && todoThinkingOverridePatternKey(candidate.pattern) === nextKey
    ));
    if (duplicate) {
      rowError = { pattern: row.pattern, message: "This model or pattern already has an override." };
      return;
    }
    onRename(row, next);
  }

  function add(): void {
    const pattern = newPattern.trim();
    if (!pattern || !canAdd) return;
    rowError = undefined;
    onAdd(pattern, { min: newMin, max: newMax });
    newPattern = "";
  }
</script>

<div class="min-w-0">
  <div class="divide-y divide-sidebar-border/50">
    {#each rows as row (todoThinkingOverridePatternKey(row.pattern))}
      <div class="min-w-0 space-y-1.5 py-2 first:pt-0">
        <div class="min-w-0" title={row.inherited ? inheritedLabel(row) : undefined}>
          <SettingsModelSelect
            value={row.pattern}
            {models}
            allowCustom
            disabled={row.inherited}
            ariaLabel={"Todo thinking model or pattern " + row.pattern}
            onChange={(value) => rename(row, value)}
          />
          {#if rowError?.pattern === row.pattern}
            <p class="mt-0.5 text-xs leading-3.5 text-tool-error" role="alert">{rowError.message}</p>
          {:else if row.level && todoThinkingRangeError(row.level)}
            <p class="mt-0.5 text-xs leading-3.5 text-tool-error" role="alert">{todoThinkingRangeError(row.level)}</p>
          {/if}
        </div>

        <div class="flex items-center gap-1.5">
          {#each BOUNDS as bound}
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{bound === "min" ? "Min" : "Max"}</span>
              <div class="min-w-0 flex-1">
                <SettingsSelect
                  value={levelValue(row, bound)}
                  options={rowLevelOptions(row)}
                  ariaLabel={"Todo thinking " + bound + " for " + row.pattern}
                  onChange={(value) => changeLevel(row, bound, value)}
                />
              </div>
            </div>
          {/each}

          {#if row.explicit}
            <button
              class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              type="button"
              aria-label={(row.inherited ? "Restore inherited override for " : "Remove override for ") + row.pattern}
              title={row.inherited ? "Restore inherited value" : "Remove override"}
              onclick={() => {
                rowError = undefined;
                onRemove(row);
              }}
            >
              {#if row.inherited}
                <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              {:else}
                <X class="h-3.5 w-3.5" aria-hidden="true" />
              {/if}
            </button>
          {:else}
            <span class="h-7 w-7 shrink-0" aria-hidden="true"></span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="flex items-start gap-1 border-t border-sidebar-border/50 pt-1.5">
    <details class="min-w-0 flex-1">
      <summary class="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <Plus class="h-3.5 w-3.5" aria-hidden="true" /> Add override
      </summary>
      <div class="pt-1.5">
        <div class="min-w-0 space-y-1.5">
          <div class="min-w-0">
            <SettingsModelSelect
              value={newPattern}
              {models}
              allowCustom
              emptyLabel="provider/model or wildcard"
              ariaLabel="New todo thinking model or pattern"
              onChange={(value) => newPattern = value}
            />
            {#if duplicateNewPattern}
              <p class="mt-0.5 text-xs leading-3.5 text-tool-error">This pattern already exists.</p>
            {/if}
          </div>
          <div class="flex items-center gap-1.5">
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">Min</span>
              <div class="min-w-0 flex-1">
                <SettingsSelect
                  value={newMin}
                  options={TODO_THINKING_LEVEL_OPTIONS}
                  ariaLabel="New todo thinking min"
                  onChange={(value) => newMin = value}
                />
              </div>
            </div>
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">Max</span>
              <div class="min-w-0 flex-1">
                <SettingsSelect
                  value={newMax}
                  options={TODO_THINKING_LEVEL_OPTIONS}
                  ariaLabel="New todo thinking max"
                  onChange={(value) => newMax = value}
                />
              </div>
            </div>
            <button
              class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-panel-strong text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              type="button"
              aria-label="Add todo thinking override"
              title="Add override"
              disabled={!canAdd}
              onclick={add}
            ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        </div>
        {#if newRangeError}
          <p class="mt-0.5 text-xs leading-3.5 text-tool-error" role="alert">{newRangeError}</p>
        {/if}
      </div>
    </details>
    <button
      type="button"
      class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label="About todo thinking limits"
      title="Choose Min / Max for exact provider/model names, bare model names, or wildcard patterns (* and ?). Equal bounds force one level. No override clears inherited policy. Only supported levels are used; if none fit, the ceiling takes priority, or the model uses its lowest supported level."
    ><Info class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </div>
</div>
