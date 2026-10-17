<script lang="ts">
  import { iconButtonClass } from "../lib/icon-button";
  import { confirmDesktopAction } from "../lib/confirm-action";
  import Play from "@lucide/svelte/icons/play";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Square from "@lucide/svelte/icons/square";
  import type { LaunchRunState, LaunchRuntime } from "../lib/package-scripts";
  import Plus from "@lucide/svelte/icons/plus";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { tick } from "svelte";

  type LaunchCommand = { id: string; name: string; command: string };

  let {
    commands,
    workspace,
    disabled,
    onSave,
    onDelete,
    onRun,
    runtimes = {},
    activeTerminalId = null,
    startingId = null,
    onStop,
    onRestart,
    onFocus,
  }: {
    commands: readonly LaunchCommand[];
    workspace: string;
    disabled: boolean;
    onSave: (command: LaunchCommand) => Promise<boolean>;
    onDelete: (id: string) => Promise<boolean>;
    onRun: (id: string) => void | Promise<void>;
    runtimes?: Readonly<Record<string, LaunchRuntime>>;
    activeTerminalId?: string | null;
    startingId?: string | null;
    onStop?: (terminalId: string) => void | Promise<void>;
    onRestart?: (terminalId: string) => void | Promise<void>;
    onFocus?: (terminalId: string) => void | Promise<void>;
  } = $props();

  const stateDot: Record<Exclude<LaunchRunState, "running">, { tone: string; label: string }> = {
    idle: { tone: "bg-muted-foreground/60", label: "Finished; terminal ready for reuse" },
    succeeded: { tone: "bg-tool-success", label: "Finished" },
    failed: { tone: "bg-tool-error", label: "Failed" },
    stopped: { tone: "bg-muted-foreground/40", label: "Stopped" },
  };

  function activate(item: LaunchCommand, runtime: LaunchRuntime | undefined): void {
    // Like Zed: clicking a running task reveals its terminal instead of duplicating it.
    if (runtime?.state === "running" && onFocus) void onFocus(runtime.terminalId);
    else void onRun(item.id);
  }

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
    if (busy) return;
    const requestWorkspace = workspace;
    busy = true;
    try {
      if (!await confirmDesktopAction(`Delete “${command.name}” launch command?`, {
        title: "Delete launch command?", okLabel: "Delete",
      })) return;
      if (workspace !== requestWorkspace || !commands.some(item => item.id === command.id)) return;
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
    <button class={iconButtonClass("sm", "panel")} type="button" title="Add launch command" aria-label="Add launch command" disabled={editing !== null || busy || !workspace} onclick={() => void beginEdit()}><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </div>
  <div class="max-h-44 overflow-y-auto">
    {#each commands as item (item.id)}
      {@const runtime = runtimes[item.id]}
      {@const running = runtime?.state === "running"}
      {@const starting = startingId === `launch:${item.id}`}
      {@const selected = runtime !== undefined && runtime.terminalId === activeTerminalId}
      <div
        class={[
          "group relative mx-1 flex min-h-7 items-center gap-1 rounded-md px-1.5",
          running ? "bg-tool-success/10 hover:bg-tool-success/15" : "hover:bg-panel-hover",
          selected ? "ring-1 ring-inset ring-primary/40" : "",
        ]}
        data-state={running ? "running" : runtime?.state ?? "none"}
      >
        {#if running}<span class="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-tool-success" aria-hidden="true"></span>{/if}
        <button
          class={[
            "group/run flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-0.5 text-left font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
            running ? "text-foreground" : "hover:text-primary",
          ]}
          type="button"
          title={running ? `${item.name} is running · show terminal` : `Run ${item.name}\n${item.command}`}
          disabled={editing !== null || (!running && (busy || disabled))}
          onclick={() => activate(item, runtime)}
        >
          <span class="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground group-hover/run:text-primary">
            {#if running || starting}
              <LoaderCircle class="h-3 w-3 animate-spin text-tool-success" aria-hidden="true" />
            {:else}
              <Play class="h-3 w-3" aria-hidden="true" />
            {/if}
          </span>
          <span class={["min-w-0 flex-1 truncate", running ? "font-medium" : ""]}>{item.name}</span>
          {#if running}<span class="sr-only">running</span>{/if}
          {#if runtime && runtime.state !== "running"}
            <span class={["h-1.5 w-1.5 shrink-0 rounded-full", stateDot[runtime.state].tone]} title={stateDot[runtime.state].label} aria-label={stateDot[runtime.state].label}></span>
          {/if}
        </button>
        {#if runtime && onRestart && (running || runtime.state === "idle")}
          <button class={iconButtonClass("sm", "panel")} type="button" title={`Restart ${item.name}`} aria-label={`Restart ${item.name}`} disabled={disabled || editing !== null} onclick={() => void onRestart(runtime.terminalId)}><RotateCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
        {/if}
        {#if running && runtime && onStop}
          <button class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title={`Stop ${item.name} (Ctrl+C)`} aria-label={`Stop ${item.name}`} disabled={disabled} onclick={() => void onStop(runtime.terminalId)}><Square class="h-3 w-3 fill-current" aria-hidden="true" /></button>
        {/if}
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button class={iconButtonClass("sm", "panel")} type="button" title={`Edit ${item.name}`} aria-label={`Edit ${item.name}`} disabled={busy || editing !== null} onclick={() => void beginEdit(item)}><Pencil class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class="grid h-6 w-6 shrink-0 place-items-center rounded text-tool-error hover:bg-tool-error/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} disabled={busy || editing !== null} onclick={() => void remove(item)}><Trash2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
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
