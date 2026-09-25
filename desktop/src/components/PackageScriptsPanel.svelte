<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import TerminalSquare from "@lucide/svelte/icons/square-terminal";
  import { onMount } from "svelte";
  import { filterPackageScripts } from "../lib/package-scripts";
  import { createPackageScriptsController } from "./package-scripts-controller.svelte";
  import SavedLaunchCommands from "./SavedLaunchCommands.svelte";
  import TerminalSessionsPane, { type TerminalSurfaceHandle } from "./TerminalSessionsPane.svelte";

  let { workspace, afterWorkspaceSave }: { workspace: string; afterWorkspaceSave: (workspace: string) => void } = $props();

  let query = $state("");
  let terminalView = $state<TerminalSurfaceHandle | null>(null);
  const controller = createPackageScriptsController({
    workspace: () => workspace,
    terminalView: () => terminalView,
    afterWorkspaceSave: (savedWorkspace) => afterWorkspaceSave(savedWorkspace),
  });
  const snapshot = $derived(controller.snapshot);
  const terminals = $derived(controller.terminals);
  const activeTerminalId = $derived(controller.activeTerminalId);
  const activeTerminal = $derived(controller.activeTerminal);
  const runningCount = $derived(controller.runningCount);
  const loading = $derived(controller.loading);
  const error = $derived(controller.error);
  const startingScript = $derived(controller.startingScript);
  const terminalActionId = $derived(controller.terminalActionId);
  const launchCommands = $derived(controller.launchCommands);

  const visibleScripts = $derived(filterPackageScripts(snapshot?.scripts ?? [], query));
  const refresh = controller.refresh;
  const runScript = controller.runScript;

  onMount(controller.start);

</script>

<section class="relative grid min-h-0 min-w-0 w-full max-w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-sidebar" aria-label="Package scripts">
  <div class="min-w-0 overflow-hidden border-b border-sidebar-border bg-panel">
    <div class="flex min-w-0 items-center gap-2 px-2.5 py-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <strong class="truncate text-xs font-medium text-foreground">{snapshot?.packageName ?? "package.json"}</strong>
          {#if snapshot}<span class="shrink-0 font-mono text-xs text-muted-foreground">{snapshot.packageManager}</span>{/if}
          {#if runningCount > 0}<span class="shrink-0 text-xs text-tool-success">{runningCount} running</span>{/if}
        </div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground/70" title={snapshot?.packagePath}>{snapshot?.packagePath ?? "Reading package.json…"}</div>
      </div>
      <button
        class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        title="Refresh package scripts"
        aria-label="Refresh package scripts"
        disabled={loading}
        onclick={refresh}
      ><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>

    {#if snapshot?.exists && snapshot.scripts.length > 0}
      <div class="border-t border-sidebar-border/70 px-2 py-1.5">
        <label class="relative block">
          <span class="sr-only">Search package scripts</span>
          <Search class="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            class="h-7 w-full rounded-md border border-input bg-panel-strong pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
            type="search"
            placeholder="Filter scripts…"
            bind:value={query}
            autocomplete="off"
          />
        </label>
      </div>
      <div class="max-h-44 space-y-0.5 overflow-y-auto border-t border-sidebar-border/70 p-1">
        {#each visibleScripts as script (script.name)}
          <button
            class="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            title={`Run ${script.name}`}
            disabled={startingScript !== null || terminalActionId !== null}
            onclick={() => void runScript(script)}
          >
            <span class="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground group-hover:text-primary">
              <Play class={["h-3 w-3", startingScript === script.name ? "animate-pulse" : ""]} aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{script.name}</span>
          </button>
        {/each}
        {#if visibleScripts.length === 0}<div class="px-3 py-4 text-center text-xs text-muted-foreground">No matching scripts.</div>{/if}
      </div>
    {:else if snapshot && !snapshot.exists}
      <div class="border-t border-sidebar-border/70 px-3 py-4 text-center">
        <TerminalSquare class="mx-auto mb-1.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">No package.json</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Add one at the project root to run package scripts.</p>
      </div>
    {:else if snapshot && snapshot.scripts.length === 0}
      <div class="border-t border-sidebar-border/70 px-3 py-4 text-center text-xs text-muted-foreground">No scripts in package.json.</div>
    {/if}
    {#key workspace}
      <SavedLaunchCommands
        commands={launchCommands}
        {workspace}
        disabled={startingScript !== null || terminalActionId !== null || loading}
        onSave={controller.saveLaunchCommand}
        onDelete={controller.deleteLaunchCommand}
        onRun={controller.runLaunchCommand}
      />
    {/key}
  </div>

  <TerminalSessionsPane
    {workspace}
    {terminals}
    {activeTerminalId}
    {activeTerminal}
    {loading}
    {error}
    {startingScript}
    {terminalActionId}
    bind:terminalView
    ariaLabel="Package terminals"
    emptyDescription="Run a package script or press + to open an interactive shell."
    onSelectTerminal={controller.selectTerminal}
    onOpenShellTerminal={controller.openShellTerminal}
    onWriteTerminal={controller.writeTerminal}
    onResizeTerminal={controller.resizeTerminal}
    onStopTerminal={controller.stopTerminal}
    onRestartTerminal={controller.restartTerminal}
    onCloseTerminal={controller.closeTerminal}
  />
</section>
