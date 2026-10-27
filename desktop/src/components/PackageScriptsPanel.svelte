<script lang="ts">
  import { emptyStateClass } from "../lib/status-text";
  import Play from "@lucide/svelte/icons/play";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Square from "@lucide/svelte/icons/square";
  import type { PackageTerminalView } from "../lib/package-scripts";
  import Search from "@lucide/svelte/icons/search";
  import { onMount } from "svelte";
  import { filterPackageScripts } from "../lib/package-scripts";
  import type { createPackageScriptsController } from "./package-scripts-controller.svelte";
  import SavedLaunchCommands from "./SavedLaunchCommands.svelte";
  import TerminalSessionsPane, { type TerminalSurfaceHandle } from "./TerminalSessionsPane.svelte";

  let { workspace, controller, terminalView = $bindable(null) }: {
    workspace: string;
    controller: ReturnType<typeof createPackageScriptsController>;
    terminalView: TerminalSurfaceHandle | null;
  } = $props();

  let query = $state("");
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
  const launchRuntimes = $derived(controller.launchRuntimes);
  const scriptRuntimes = $derived(controller.scriptRuntimes);
  // With no terminals the terminal pane collapses to its tab strip and the
  // command lists take the freed height.
  const terminalCollapsed = $derived(terminals.length === 0 && !loading);

  function terminalLabel(terminal: PackageTerminalView): string {
    const launch = terminal.launchCommandId ? launchCommands.find((item) => item.id === terminal.launchCommandId) : undefined;
    return launch?.name ?? terminal.script;
  }

  const visibleScripts = $derived(filterPackageScripts(snapshot?.scripts ?? [], query));
  onMount(() => {
    if (!controller.startingScript && !controller.terminalActionId) controller.refresh();
  });
</script>

<section class={[
  "relative grid min-h-0 min-w-0 w-full max-w-full overflow-hidden bg-sidebar",
  terminalCollapsed ? "grid-rows-[minmax(0,1fr)_auto]" : "grid-rows-[auto_minmax(0,1fr)]",
]} aria-label="Launch commands and terminals">
  <div class={["min-w-0 border-b border-sidebar-border bg-panel", terminalCollapsed ? "overflow-y-auto" : "overflow-hidden"]}>
    {#key workspace}
      <SavedLaunchCommands
        commands={launchCommands}
        {workspace}
        disabled={startingScript !== null || terminalActionId !== null || loading}
        onSave={controller.saveLaunchCommand}
        onDelete={controller.deleteLaunchCommand}
        onRun={controller.runLaunchCommand}
        runtimes={launchRuntimes}
        {activeTerminalId}
        startingId={startingScript}
        onStop={controller.stopProcess}
        onRestart={controller.restartProcess}
        onFocus={controller.selectTerminal}
      />
    {/key}

    {#if snapshot?.exists}
      <section class="border-t border-sidebar-border/70" aria-label="Package scripts">
        <div class="flex min-w-0 items-center gap-2 px-2.5 py-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <strong class="truncate text-xs font-medium text-foreground">{snapshot.packageName ?? "package.json"}</strong>
              <span class="shrink-0 font-mono text-xs text-muted-foreground">{snapshot.packageManager}</span>
              {#if runningCount > 0}<span class="shrink-0 text-xs text-tool-success">{runningCount} running</span>{/if}
            </div>
            <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground/70" title={snapshot.packagePath}>{snapshot.packagePath}</div>
          </div>
        </div>

        {#if snapshot.scripts.length > 0}
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
              {@const runtime = scriptRuntimes[script.name]}
              {@const running = runtime?.state === "running"}
              {@const selected = runtime !== undefined && runtime.terminalId === activeTerminalId}
              <div
                class={[
                  "group relative flex h-7 w-full items-center gap-1 rounded-md pr-1",
                  running ? "bg-tool-success/10 hover:bg-tool-success/15" : "hover:bg-panel-hover",
                  selected ? "ring-1 ring-inset ring-primary/40" : "",
                ]}
                data-state={running ? "running" : runtime?.state ?? "none"}
              >
                {#if running}<span class="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-tool-success" aria-hidden="true"></span>{/if}
                <button
                  class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
                  type="button"
                  title={running ? `${script.name} is running · show terminal` : `Run ${script.name}\n${script.command}`}
                  disabled={!running && (startingScript !== null || terminalActionId !== null)}
                  onclick={() => void controller.launchScript(script)}
                >
                  <span class="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground group-hover:text-primary">
                    {#if running || startingScript === script.name}
                      <LoaderCircle class="h-3 w-3 animate-spin text-tool-success" aria-hidden="true" />
                    {:else}
                      <Play class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{script.name}</span>
                  {#if running}<span class="sr-only">running</span>{/if}
                  {#if runtime && !running}
                    <span class={["h-1.5 w-1.5 shrink-0 rounded-full", runtime.state === "failed" ? "bg-tool-error" : runtime.state === "succeeded" ? "bg-tool-success" : "bg-muted-foreground/40"]} aria-label={runtime.state} title={runtime.state}></span>
                  {/if}
                </button>
                {#if running && runtime}
                  <button
                    class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                    type="button"
                    title={`Stop ${script.name}`}
                    aria-label={`Stop ${script.name}`}
                    disabled={terminalActionId !== null}
                    onclick={() => void controller.stopProcess(runtime.terminalId)}
                  ><Square class="h-3 w-3 fill-current" aria-hidden="true" /></button>
                {/if}
              </div>
            {/each}
            {#if visibleScripts.length === 0}<div class={emptyStateClass}>No matching scripts.</div>{/if}
          </div>
        {:else}
          <div class="border-t border-sidebar-border/70 px-3 py-3 text-center text-xs text-muted-foreground">No scripts in package.json.</div>
        {/if}
      </section>
    {/if}
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
    ariaLabel="Launch terminals"
    collapseWhenEmpty
    emptyDescription="Run a launch command or package script, or press + to open an interactive shell."
    onSelectTerminal={controller.selectTerminal}
    onOpenShellTerminal={controller.openShellTerminal}
    onWriteTerminal={controller.writeTerminal}
    onResizeTerminal={controller.resizeTerminal}
    onStopTerminal={(terminal) => controller.stopProcess(terminal.id)}
    onRestartTerminal={(terminal) => controller.restartProcess(terminal.id)}
    onCloseTerminal={controller.closeTerminal}
    isTerminalBusy={controller.isTerminalBusy}
    {terminalLabel}
  />
</section>
