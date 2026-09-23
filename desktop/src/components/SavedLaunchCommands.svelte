<script lang="ts">
  import { tick } from "svelte";

  type LaunchCommand = { id: string; name: string; command: string };

  let {
    commands,
    workspace,
    disabled,
    onSave,
    onDelete,
    onRun,
  }: {
    commands: readonly LaunchCommand[];
    workspace: string;
    disabled: boolean;
    onSave: (command: LaunchCommand) => Promise<boolean>;
    onDelete: (id: string) => Promise<boolean>;
    onRun: (id: string) => void | Promise<void>;
  } = $props();

  let editing = $state<LaunchCommand | null>(null);
  let busy = $state(false);
  let nameInput = $state<HTMLInputElement>();
  let trigger: HTMLElement | null = null;

  async function beginEdit(command?: LaunchCommand): Promise<void> {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editing = command ? { ...command } : { id: crypto.randomUUID(), name: "", command: "" };
    await tick();
    nameInput?.focus();
  }

  async function cancelEdit(): Promise<void> {
    editing = null;
    await tick();
    trigger?.focus();
    trigger = null;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!editing || busy || !editing.name.trim() || !editing.command.trim()) return;
    busy = true;
    try {
      if (await onSave(editing)) await cancelEdit();
    } finally {
      busy = false;
    }
  }

  async function remove(command: LaunchCommand): Promise<void> {
    if (busy || !confirm(`Delete “${command.name}” launch command?`)) return;
    busy = true;
    try {
      await onDelete(command.id);
    } finally {
      busy = false;
    }
  }

  function handleEditorKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    event.stopPropagation();
    void cancelEdit();
  }
</script>

<section class="border-t border-sidebar-border/70" aria-label="Saved launch commands">
  <div class="flex h-8 items-center justify-between px-2.5">
    <strong class="text-xs font-medium">Saved launch commands</strong>
    <button class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={editing !== null || busy || !workspace} onclick={() => void beginEdit()}>Add</button>
  </div>
  <div class="max-h-44 overflow-y-auto">
    {#each commands as item (item.id)}
      <div class="group flex min-h-7 items-center gap-1 px-2">
        <button class="min-w-0 flex-1 truncate text-left font-mono text-xs hover:text-primary disabled:opacity-40" type="button" title={`Run ${item.name}`} disabled={busy || disabled || editing !== null} onclick={() => void onRun(item.id)}>{item.name}</button>
        <button class="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" aria-label={`Edit ${item.name}`} disabled={busy || editing !== null} onclick={() => void beginEdit(item)}>Edit</button>
        <button class="rounded px-1.5 py-1 text-xs text-tool-error hover:bg-tool-error/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" aria-label={`Delete ${item.name}`} disabled={busy || editing !== null} onclick={() => void remove(item)}>Delete</button>
      </div>
    {/each}
    {#if commands.length === 0 && editing === null}<p class="px-2.5 pb-2 text-xs text-muted-foreground">No saved commands.</p>{/if}
  </div>
  {#if editing}
    <form class="space-y-1.5 border-t border-sidebar-border/50 p-2" onsubmit={(event) => void save(event)}>
      <input bind:this={nameInput} bind:value={editing.name} aria-label="Launch command name" placeholder="Name" class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 text-xs" autocomplete="off" onkeydown={handleEditorKeydown} />
      <input bind:value={editing.command} aria-label="Shell command" placeholder="Shell command" class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs" autocomplete="off" onkeydown={handleEditorKeydown} />
      <div class="flex justify-end gap-1">
        <button class="rounded px-2 py-1 text-xs hover:bg-panel-hover" type="button" disabled={busy} onclick={() => void cancelEdit()}>Cancel</button>
        <button class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-40" type="submit" disabled={busy || !editing.name.trim() || !editing.command.trim()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  {/if}
</section>
