<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import X from "@lucide/svelte/icons/x";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import {
    TODO_THINKING_LEVEL_OPTIONS,
    todoThinkingOverridePatternKey,
    type TodoThinkingOverrideRow,
    type TodoThinkingOverrideValue,
  } from "../../lib/todo-thinking-overrides-settings";
  import SettingsSelect from "./SettingsSelect.svelte";

  const NO_OVERRIDE = "__no_override__";

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
    onAdd: (pattern: string, level: string) => void;
    onRename: (row: TodoThinkingOverrideRow, pattern: string) => void;
    onLevelChange: (row: TodoThinkingOverrideRow, level: TodoThinkingOverrideValue) => void;
    onRemove: (row: TodoThinkingOverrideRow) => void;
  } = $props();

  let newPattern = $state("");
  let newLevel = $state("high");

  const newPatternKey = $derived(todoThinkingOverridePatternKey(newPattern));
  const duplicateNewPattern = $derived(Boolean(
    newPatternKey && rows.some((row) => todoThinkingOverridePatternKey(row.pattern) === newPatternKey),
  ));
  const canAdd = $derived(Boolean(newPatternKey) && !duplicateNewPattern);

  function levelValue(row: TodoThinkingOverrideRow): string {
    return row.level === null ? NO_OVERRIDE : row.level;
  }

  function inheritedLabel(row: TodoThinkingOverrideRow): string {
    if (row.level === null) return "Inherited policy disabled";
    if (row.explicit) return "Overrides inherited policy";
    return "Inherited policy";
  }

  function changeLevel(row: TodoThinkingOverrideRow, raw: string): void {
    if (raw !== NO_OVERRIDE) {
      onLevelChange(row, raw);
      return;
    }
    if (row.inherited) onLevelChange(row, null);
    else onRemove(row);
  }

  function rowLevelOptions(row: TodoThinkingOverrideRow): Array<{ value: string; label: string }> {
    return [
      ...TODO_THINKING_LEVEL_OPTIONS,
      { value: NO_OVERRIDE, label: row.inherited ? "No override" : "Remove" },
    ];
  }

  function rename(row: TodoThinkingOverrideRow, event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const next = input.value.trim();
    const nextKey = todoThinkingOverridePatternKey(next);
    const currentKey = todoThinkingOverridePatternKey(row.pattern);
    if (!nextKey || nextKey === currentKey) {
      input.value = row.pattern;
      return;
    }
    const duplicate = rows.some((candidate) => (
      candidate !== row && todoThinkingOverridePatternKey(candidate.pattern) === nextKey
    ));
    if (duplicate) {
      input.setCustomValidity("This model or pattern already has an override.");
      input.reportValidity();
      input.value = row.pattern;
      return;
    }
    input.setCustomValidity("");
    onRename(row, next);
  }

  function add(): void {
    const pattern = newPattern.trim();
    if (!pattern || !canAdd) return;
    onAdd(pattern, newLevel);
    newPattern = "";
  }
</script>

<div class="space-y-1.5">
  <datalist id="todo-thinking-model-patterns">
    {#each models as model (model.ref)}
      <option value={model.ref}>{model.name}</option>
    {/each}
  </datalist>

  <div class="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground" aria-hidden="true">
    <span class="min-w-0 flex-1">Model / pattern</span>
    <span class="w-28 shrink-0">Thinking</span>
    <span class="w-7 shrink-0"></span>
  </div>

  {#each rows as row (todoThinkingOverridePatternKey(row.pattern))}
    <div class="flex items-start gap-1.5">
      <div class="min-w-0 flex-1">
        <input
          class={[
            "h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30",
            row.inherited ? "read-only:text-muted-foreground" : "",
          ]}
          type="text"
          value={row.pattern}
          list={row.inherited ? undefined : "todo-thinking-model-patterns"}
          readonly={row.inherited}
          aria-label={"Todo thinking model or pattern " + row.pattern}
          title={row.inherited ? "Inherited/default pattern. Add another row for a different pattern." : undefined}
          autocomplete="off"
          spellcheck="false"
          onchange={(event) => rename(row, event)}
        />
        {#if row.inherited}
          <p class="mt-0.5 truncate text-xs leading-3.5 text-muted-foreground">
            {inheritedLabel(row)}
          </p>
        {/if}
      </div>

      <div class="w-28 shrink-0">
        <SettingsSelect
          value={levelValue(row)}
          options={rowLevelOptions(row)}
          ariaLabel={"Todo thinking level for " + row.pattern}
          onChange={(value) => changeLevel(row, value)}
        />
      </div>

      {#if row.explicit}
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          aria-label={(row.inherited ? "Restore inherited override for " : "Remove override for ") + row.pattern}
          title={row.inherited ? "Restore inherited value" : "Remove override"}
          onclick={() => onRemove(row)}
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
  {/each}

  <div class="border-t border-sidebar-border/50 pt-1.5">
    <div class="flex items-start gap-1.5">
      <div class="min-w-0 flex-1">
        <input
          class={[
            "h-7 w-full rounded-md border bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring/30",
            duplicateNewPattern ? "border-tool-error" : "border-input",
          ]}
          type="text"
          list="todo-thinking-model-patterns"
          placeholder="provider/model or wildcard"
          aria-label="New todo thinking model or pattern"
          autocomplete="off"
          spellcheck="false"
          bind:value={newPattern}
          onkeydown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        {#if duplicateNewPattern}
          <p class="mt-0.5 text-xs leading-3.5 text-tool-error">This pattern already exists.</p>
        {/if}
      </div>
      <div class="w-28 shrink-0">
        <SettingsSelect
          value={newLevel}
          options={TODO_THINKING_LEVEL_OPTIONS}
          ariaLabel="New todo thinking level"
          onChange={(value) => newLevel = value}
        />
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

  <p class="text-xs leading-4 text-muted-foreground">
    Exact provider/model and bare-model names are supported; use <span class="font-mono">*</span> or <span class="font-mono">?</span> for patterns. Unsupported levels are normalized per model.
  </p>
</div>
