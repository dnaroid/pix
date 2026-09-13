<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Search from "@lucide/svelte/icons/search";
  import Square from "@lucide/svelte/icons/square";
  import TerminalSquare from "@lucide/svelte/icons/square-terminal";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import {
    filterPackageScripts,
    packageTerminalStatusLabel,
    type PackageTerminalView,
  } from "../lib/package-scripts";
  import { createPackageScriptsController } from "./package-scripts-controller.svelte";
  import TerminalView from "./TerminalView.svelte";

  let { workspace }: { workspace: string } = $props();

  let query = $state("");
  let terminalView = $state<{
    write: (data: string) => void;
    focus: () => void;
    dimensions: () => { cols: number; rows: number };
  } | null>(null);
  const controller = createPackageScriptsController({
    workspace: () => workspace,
    terminalView: () => terminalView,
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

  const visibleScripts = $derived(filterPackageScripts(snapshot?.scripts ?? [], query));
  const refresh = controller.refresh;
  const runScript = controller.runScript;
  const openShellTerminal = controller.openShellTerminal;
  const writeTerminal = controller.writeTerminal;
  const resizeTerminal = controller.resizeTerminal;
  const stopTerminal = controller.stopTerminal;
  const restartTerminal = controller.restartTerminal;
  const closeTerminal = controller.closeTerminal;

  onMount(controller.start);

  export async function openTerminal(command: string): Promise<void> {
    await controller.openShellTerminal(command);
  }

  function terminalTone(terminal: PackageTerminalView): string {
    if (terminal.status === "running") return "bg-primary";
    if (terminal.status === "failed" || (terminal.status === "exited" && terminal.exitCode !== 0)) return "bg-tool-error";
    if (terminal.status === "exited" && terminal.exitCode === 0) return "bg-tool-success";
    return "bg-muted-foreground/60";
  }

</script>

<section class="relative grid min-h-0 min-w-0 w-full max-w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-sidebar" aria-label="Package scripts">
  <div class="min-w-0 overflow-hidden border-b border-sidebar-border bg-panel">
    <div class="flex min-w-0 items-center gap-2 px-2.5 py-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <strong class="truncate text-[11px] font-medium text-foreground">{snapshot?.packageName ?? "package.json"}</strong>
          {#if snapshot}<span class="shrink-0 font-mono text-[10px] text-muted-foreground">{snapshot.packageManager}</span>{/if}
          {#if runningCount > 0}<span class="shrink-0 text-[10px] text-tool-success">{runningCount} running</span>{/if}
        </div>
        <div class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70" title={snapshot?.packagePath}>{snapshot?.packagePath ?? "Reading package.json…"}</div>
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
            class="h-7 w-full rounded-md border border-input bg-panel-strong pr-2 pl-7 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
            type="search"
            placeholder="Filter scripts…"
            bind:value={query}
            autocomplete="off"
          />
        </label>
      </div>
      <div class="max-h-44 overflow-y-auto border-t border-sidebar-border/70 py-1">
        {#each visibleScripts as script (script.name)}
          <button
            class="group flex min-h-8 w-full cursor-pointer items-start gap-2 px-2.5 py-1 text-left hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            title={`Run ${script.name}`}
            disabled={startingScript !== null || terminalActionId !== null}
            onclick={() => void runScript(script)}
          >
            <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground group-hover:text-primary">
              <Play class={["h-3 w-3", startingScript === script.name ? "animate-pulse" : ""]} aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-mono text-[11px] font-medium text-foreground">{script.name}</span>
              <span class="block truncate font-mono text-[10px] leading-3.5 text-muted-foreground" title={script.command}>{script.command}</span>
            </span>
          </button>
        {/each}
        {#if visibleScripts.length === 0}<div class="px-3 py-4 text-center text-[11px] text-muted-foreground">No matching scripts.</div>{/if}
      </div>
    {:else if snapshot && !snapshot.exists}
      <div class="border-t border-sidebar-border/70 px-3 py-4 text-center">
        <TerminalSquare class="mx-auto mb-1.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <p class="text-[11px] font-medium text-foreground">No package.json</p>
        <p class="mt-0.5 text-[11px] text-muted-foreground">Add one at the project root to run package scripts.</p>
      </div>
    {:else if snapshot && snapshot.scripts.length === 0}
      <div class="border-t border-sidebar-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">No scripts in package.json.</div>
    {/if}
  </div>

  <div class="grid min-h-0 min-w-0 w-full max-w-full grid-rows-[32px_minmax(0,1fr)] overflow-hidden bg-code">
    <div class="flex min-w-0 items-stretch border-b border-code-border bg-chrome">
      <div class="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Package terminals">
        {#each terminals as terminal (terminal.id)}
          {@const selected = terminal.id === activeTerminalId}
          <div class={[
            "group flex h-8 min-w-[110px] max-w-[190px] items-center border-r border-code-border/70",
            selected ? "bg-code text-foreground" : "text-muted-foreground hover:bg-chrome-hover hover:text-foreground",
          ]}>
            <button
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              type="button"
              role="tab"
              aria-selected={selected}
              title={`${terminal.script} · ${packageTerminalStatusLabel(terminal)}`}
              onclick={() => void controller.selectTerminal(terminal.id)}
            >
              <span class={["h-1.5 w-1.5 shrink-0 rounded-full", terminalTone(terminal)]} aria-hidden="true"></span>
              <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{terminal.script}</span>
            </button>
            <button
              class="mr-0.5 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
              type="button"
              title="Close terminal"
              aria-label={`Close ${terminal.script} terminal`}
              onclick={() => void closeTerminal(terminal)}
            ><X class="h-3 w-3" aria-hidden="true" /></button>
          </div>
        {/each}
      </div>

      {#if activeTerminal}
        <div class="flex shrink-0 items-center border-l border-code-border/70 px-0.5">
          <span class="max-w-28 truncate px-1.5 font-mono text-[10px] text-muted-foreground" title={packageTerminalStatusLabel(activeTerminal)}>
            {packageTerminalStatusLabel(activeTerminal)}
          </span>
          <button
            class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
            type="button"
            title="Restart terminal"
            aria-label="Restart terminal"
            disabled={terminalActionId !== null || startingScript !== null}
            onclick={() => void restartTerminal(activeTerminal)}
          ><RotateCw class={["h-3.5 w-3.5", terminalActionId === activeTerminal.id ? "animate-spin" : ""]} aria-hidden="true" /></button>
          <button
            class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30"
            type="button"
            title="Stop terminal"
            aria-label="Stop terminal"
            disabled={activeTerminal.status !== "running" || terminalActionId !== null}
            onclick={() => void stopTerminal(activeTerminal)}
          ><Square class="h-3 w-3 fill-current" aria-hidden="true" /></button>
        </div>
      {/if}
      <button
        class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
        type="button"
        title="New terminal"
        aria-label="Open new terminal"
        disabled={!workspace || terminalActionId !== null || startingScript !== null}
        onclick={() => void openShellTerminal()}
      ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>

    <div class="relative min-h-0 min-w-0 w-full max-w-full overflow-hidden bg-code">
      {#if activeTerminal}
        {#key activeTerminal.id}
          <TerminalView
            bind:this={terminalView}
            initialContent={activeTerminal.output}
            running={activeTerminal.status === "running"}
            ariaLabel={`${activeTerminal.script} terminal`}
            onInput={(data) => void writeTerminal(activeTerminal.id, data)}
            onResize={(cols, rows) => void resizeTerminal(activeTerminal.id, cols, rows)}
          />
        {/key}
      {:else if loading}
        <div class="absolute inset-0 flex min-w-0 items-center justify-center px-4 text-[11px] text-muted-foreground"><span class="inline-flex items-center gap-1.5"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading terminals…</span></div>
      {:else}
        <div class="absolute inset-0 flex min-w-0 items-center justify-center px-4 text-center">
          <div class="max-w-64">
            <TerminalSquare class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p class="text-[11px] font-medium text-foreground">No terminal open</p>
            <p class="mt-1 text-[11px] leading-4 text-muted-foreground">Run a package script or press + to open an interactive shell.</p>
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="absolute right-2 bottom-2 left-2 z-20 rounded-md border border-tool-error/30 bg-popover px-2 py-1.5 text-[11px] leading-4 text-tool-error shadow-md" role="status">
      {error}
    </div>
  {/if}
</section>
