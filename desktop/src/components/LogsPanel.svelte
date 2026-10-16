<script lang="ts">
  import { dialogCancelButtonClass, dialogDestructiveButtonClass } from "../lib/dialog";
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { formatDiagnosticLogTime } from "../lib/diagnostic-log-time";
  import { createHistoryScrollTracker } from "../lib/index-history-scroll";
  import { createDiagnosticLogMonitor, filterDiagnosticLogs, type DiagnosticLogSnapshot, type DiagnosticLogState } from "../lib/diagnostic-log-monitor";

  let { workspace }: { workspace: string } = $props();
  let view = $state<DiagnosticLogState>({ snapshot: null, error: null, loading: false });
  let paused = $state(false);
  let level = $state("");
  let source = $state("");
  let query = $state("");
  let projectOnly = $state(false);
  let expanded = $state<string | null>(null);
  let confirmingClear = $state(false);
  let clearing = $state(false);
  let clearError = $state<string | null>(null);
  let mounted = false;
  let clearDialog = $state<HTMLDialogElement>();
  let cancelClearButton = $state<HTMLButtonElement>();
  let recordsPane = $state<HTMLDivElement>();
  let scrollTracker = $state<ReturnType<typeof createHistoryScrollTracker>>();
  const levelOptions = [
    { value: "", label: "All levels" }, { value: "error", label: "Error" },
    { value: "warn", label: "Warning" }, { value: "info", label: "Info" },
    { value: "debug", label: "Debug" },
  ];
  const sourceOptions = [
    { value: "", label: "All sources" }, { value: "backend", label: "Backend" },
    { value: "acp", label: "ACP" }, { value: "desktop", label: "Desktop" },
  ];
  const monitor = createDiagnosticLogMonitor(
    () => invoke<DiagnosticLogSnapshot>("read_diagnostic_logs"),
    next => { view = next; },
  );
  const entries = $derived(filterDiagnosticLogs(view.snapshot?.entries ?? [], {
    level, source, query, project: projectOnly ? workspace : null,
  }).reverse());
  $effect.pre(() => {
    // Capture before keyed rows change, including bounded-snapshot eviction.
    entries; expanded;
    const tracker = scrollTracker;
    if (!tracker) return;
    const position = tracker.capture();
    let cancelled = false;
    void tick().then(() => { if (!cancelled) tracker.restore(position); });
    return () => { cancelled = true; };
  });
  function sync(): void {
    if (mounted && !paused && !clearing && document.visibilityState !== "hidden") monitor.start();
    else monitor.stop();
  }
  function togglePause(): void { paused = !paused; sync(); }
  async function clearLogs(): Promise<void> {
    if (clearing || !mounted) return;
    confirmingClear = false;
    clearing = true;
    clearError = null;
    monitor.stop();
    try {
      const result = await invoke<{ clearedFiles: number; failedFiles: number }>("clear_diagnostic_logs");
      if (!mounted) return;
      monitor.discardSnapshot();
      expanded = null;
      if (result.failedFiles > 0) clearError = `Could not clear ${result.failedFiles} log files. Try again.`;
    } catch (error) {
      if (mounted) clearError = `Could not clear logs: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (mounted) { clearing = false; sync(); }
    }
  }
  $effect(() => {
    if (clearDialog) return activateModalDialog(clearDialog, () => cancelClearButton);
  });
  onMount(() => {
    mounted = true;
    const tracker = recordsPane ? createHistoryScrollTracker(recordsPane) : undefined;
    scrollTracker = tracker;
    const observer = new ResizeObserver(() => tracker?.resize());
    if (recordsPane) observer.observe(recordsPane);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { mounted = false; observer.disconnect(); document.removeEventListener("visibilitychange", sync); monitor.stop(); };
  });
</script>

<section class="flex min-h-0 min-w-0 flex-col overflow-hidden text-xs" aria-label="Diagnostic logs">
  <div class="space-y-2 border-b border-sidebar-border p-2">
    <div class="flex items-center gap-1">
      <input class="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 focus-visible:outline-2 focus-visible:outline-ring" aria-label="Search logs" placeholder="Search recent logs…" bind:value={query} />
      <button type="button" class="grid h-7 w-7 place-items-center rounded hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring" aria-label={paused ? "Resume monitoring" : "Pause monitoring"} title={paused ? "Resume monitoring" : "Pause monitoring"} aria-pressed={paused} onclick={togglePause}>
        {#if paused}<Play class="h-3.5 w-3.5" />{:else}<Pause class="h-3.5 w-3.5" />{/if}
      </button>
      <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" aria-label="Refresh logs" title="Refresh logs" disabled={paused || view.loading || clearing} onclick={() => void monitor.refresh()}><RefreshCw class="h-3.5 w-3.5" /></button>
      <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" aria-label="Clear all logs" title="Clear all logs (all projects and sources)" disabled={clearing} onclick={() => confirmingClear = true}><Trash2 class="h-3.5 w-3.5" /></button>
    </div>
    <div class="grid min-w-0 grid-cols-2 gap-2">
      <TaskFieldSelect value={level} options={levelOptions} onChange={value => level = value} ariaLabel="Log level" compact />
      <TaskFieldSelect value={source} options={sourceOptions} onChange={value => source = value} ariaLabel="Log source" compact />
    </div>
    <div class="flex items-center justify-between gap-2 text-muted-foreground">
      <label class="flex min-w-0 items-center gap-1"><input type="checkbox" bind:checked={projectOnly} />This project</label>
      <span role="status">{#if clearing}Clearing…{:else if paused}Paused{:else}Live · 2s{/if} · {entries.length} records</span>
    </div>
    <p class="text-muted-foreground" title="~/.config/pi/logs">Recent shared logs · newest last</p>
  </div>
  {#if view.error}<p role="alert" class="border-b border-sidebar-border p-2 text-destructive">{view.error}</p>{/if}
  {#if clearError}<p role="alert" class="border-b border-sidebar-border p-2 text-destructive">{clearError}</p>{/if}
  {#if view.snapshot?.limited || view.snapshot?.skipped}
    <p class="border-b border-sidebar-border p-2 text-muted-foreground">Bounded recent snapshot (up to 500 records). {view.snapshot.skipped ? `${view.snapshot.skipped} unreadable or malformed items skipped.` : "Older records may be omitted."}</p>
  {/if}
  <div bind:this={recordsPane} onscroll={() => scrollTracker?.handleScroll()} class="min-h-0 flex-1 overflow-auto [overflow-anchor:none]" aria-label="Log records">
    {#each entries as entry (entry.id)}
      <div data-event-id={entry.id} class="border-b border-sidebar-border/60">
        <button type="button" class="flex w-full items-start gap-1.5 px-2 py-2 text-left hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={expanded === entry.id} onclick={() => expanded = expanded === entry.id ? null : entry.id}>
          <ChevronRight class={["mt-0.5 h-3 w-3 shrink-0 transition-transform", expanded === entry.id && "rotate-90"]} aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap gap-x-2 text-xs text-muted-foreground"><time datetime={entry.record.time} title={entry.record.time}>{formatDiagnosticLogTime(entry.record.time)}</time><span>{entry.record.source}</span><span class:text-destructive={entry.record.level === "error"} class:text-tool-warning={entry.record.level === "warn"}>{entry.record.level.toUpperCase()}</span></span>
            <span class="block break-words font-medium">{entry.record.event}</span>
            <span class="block truncate text-muted-foreground">{entry.record.module} · {entry.record.project?.name ?? "No project"}</span>
          </span>
        </button>
        {#if expanded === entry.id}<pre class="overflow-x-auto whitespace-pre-wrap break-all bg-background px-3 py-2 font-mono text-xs leading-4">{JSON.stringify(entry.record, null, 2)}</pre>{/if}
      </div>
    {:else}
      <p class="p-4 text-muted-foreground">{view.loading && !view.snapshot ? "Loading logs…" : "No recent logs match these filters."}</p>
    {/each}
  </div>
</section>

{#if confirmingClear}
  <dialog bind:this={clearDialog} class="fixed inset-0 z-50 m-auto max-w-[calc(100vw-32px)] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md backdrop:bg-overlay" aria-label="Clear all diagnostic logs" oncancel={(event) => { event.preventDefault(); confirmingClear = false; }}>
    <h2 class="text-sm font-semibold">Clear all logs?</h2>
    <p class="mt-2 max-w-80 text-xs text-muted-foreground">Delete diagnostic logs for all projects and sources, not just the filtered records. This cannot be undone. Logging stays enabled, so new records may appear.</p>
    <div class="mt-4 flex justify-end gap-2">
      <button bind:this={cancelClearButton} type="button" class={dialogCancelButtonClass} onclick={() => confirmingClear = false}>Cancel</button>
      <button type="button" class={dialogDestructiveButtonClass} onclick={() => void clearLogs()}>Clear all logs</button>
    </div>
  </dialog>
{/if}
