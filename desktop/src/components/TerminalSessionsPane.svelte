<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Square from "@lucide/svelte/icons/square";
  import TerminalSquare from "@lucide/svelte/icons/square-terminal";
  import X from "@lucide/svelte/icons/x";
  import { packageTerminalStatusLabel, type PackageTerminalView } from "../lib/package-scripts";
  import TerminalView from "./TerminalView.svelte";

  export type TerminalSurfaceHandle = {
    write: (data: string) => void;
    focus: () => void;
    dimensions: () => { cols: number; rows: number };
  };

  let {
    workspace,
    terminals,
    activeTerminalId,
    activeTerminal,
    loading,
    error,
    startingScript,
    terminalActionId,
    terminalView = $bindable(null),
    emptyDescription = "Press + to open an interactive shell.",
    ariaLabel = "Terminals",
    onSelectTerminal,
    onOpenShellTerminal,
    onWriteTerminal,
    onResizeTerminal,
    onStopTerminal,
    onRestartTerminal,
    onCloseTerminal,
  }: {
    workspace: string;
    terminals: readonly PackageTerminalView[];
    activeTerminalId: string | null;
    activeTerminal: PackageTerminalView | undefined;
    loading: boolean;
    error: string | null;
    startingScript: string | null;
    terminalActionId: string | null;
    terminalView?: TerminalSurfaceHandle | null;
    emptyDescription?: string;
    ariaLabel?: string;
    onSelectTerminal: (terminalId: string) => void | Promise<void>;
    onOpenShellTerminal: () => void | Promise<void>;
    onWriteTerminal: (terminalId: string, data: string) => void | Promise<void>;
    onResizeTerminal: (terminalId: string, cols: number, rows: number) => void | Promise<void>;
    onStopTerminal: (terminal: PackageTerminalView) => void | Promise<void>;
    onRestartTerminal: (terminal: PackageTerminalView) => void | Promise<void>;
    onCloseTerminal: (terminal: PackageTerminalView) => void | Promise<void>;
  } = $props();

  function terminalTone(terminal: PackageTerminalView): string {
    if (terminal.status === "running") return "bg-primary";
    if (terminal.status === "failed" || (terminal.status === "exited" && terminal.exitCode !== 0)) return "bg-tool-error";
    if (terminal.status === "exited" && terminal.exitCode === 0) return "bg-tool-success";
    return "bg-muted-foreground/60";
  }
</script>

<div class="relative grid h-full min-h-0 min-w-0 w-full max-w-full grid-rows-[32px_minmax(0,1fr)] overflow-hidden bg-code">
  <div class="flex min-w-0 items-stretch border-b border-code-border bg-chrome">
    <div
      class="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label={ariaLabel}
    >
      {#each terminals as terminal (terminal.id)}
        {@const selected = terminal.id === activeTerminalId}
        <div class={[
          "group flex h-8 min-w-[110px] max-w-[220px] items-center border-r border-code-border/70",
          selected ? "bg-code text-foreground" : "text-muted-foreground hover:bg-chrome-hover hover:text-foreground",
        ]}>
          <button
            class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            type="button"
            role="tab"
            aria-selected={selected}
            title={`${terminal.script} · ${packageTerminalStatusLabel(terminal)}`}
            onclick={() => void onSelectTerminal(terminal.id)}
          >
            <span class={["h-1.5 w-1.5 shrink-0 rounded-full", terminalTone(terminal)]} aria-hidden="true"></span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{terminal.script}</span>
          </button>
          <button
            class="mr-0.5 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
            type="button"
            title="Close terminal"
            aria-label={`Close ${terminal.script} terminal`}
            onclick={() => void onCloseTerminal(terminal)}
          ><X class="h-3 w-3" aria-hidden="true" /></button>
        </div>
      {/each}
    </div>

    {#if activeTerminal}
      <div class="flex shrink-0 items-center border-l border-code-border/70 px-0.5">
        <span
          class="max-w-32 truncate px-1.5 font-mono text-xs text-muted-foreground"
          title={packageTerminalStatusLabel(activeTerminal)}
        >{packageTerminalStatusLabel(activeTerminal)}</span>
        <button
          class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
          type="button"
          title="Restart terminal"
          aria-label="Restart terminal"
          disabled={terminalActionId !== null || startingScript !== null}
          onclick={() => void onRestartTerminal(activeTerminal)}
        ><RotateCw class={["h-3.5 w-3.5", terminalActionId === activeTerminal.id ? "animate-spin" : ""]} aria-hidden="true" /></button>
        <button
          class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30"
          type="button"
          title="Stop terminal"
          aria-label="Stop terminal"
          disabled={activeTerminal.status !== "running" || terminalActionId !== null}
          onclick={() => void onStopTerminal(activeTerminal)}
        ><Square class="h-3 w-3 fill-current" aria-hidden="true" /></button>
      </div>
    {/if}

    <button
      class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
      type="button"
      title="New terminal"
      aria-label="Open new terminal"
      disabled={!workspace || terminalActionId !== null || startingScript !== null}
      onclick={() => void onOpenShellTerminal()}
    ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </div>

  <div class="relative min-h-0 min-w-0 w-full max-w-full overflow-hidden bg-code">
    {#if activeTerminal}
      {#key activeTerminal.id}
        {@const terminalId = activeTerminal.id}
        <TerminalView
          bind:this={terminalView}
          initialContent={activeTerminal.output}
          running={activeTerminal.status === "running"}
          ariaLabel={`${activeTerminal.script} terminal`}
          onInput={(data) => onWriteTerminal(terminalId, data)}
          onResize={(cols, rows) => onResizeTerminal(terminalId, cols, rows)}
        />
      {/key}
    {:else if loading}
      <div class="absolute inset-0 flex min-w-0 items-center justify-center px-4 text-xs text-muted-foreground">
        <span class="inline-flex items-center gap-1.5">
          <RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading terminals…
        </span>
      </div>
    {:else}
      <div class="absolute inset-0 flex min-w-0 items-center justify-center px-4 text-center">
        <div class="max-w-64">
          <TerminalSquare class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p class="text-xs font-medium text-foreground">No terminal open</p>
          <p class="mt-1 text-xs leading-4 text-muted-foreground">{emptyDescription}</p>
        </div>
      </div>
    {/if}
  </div>

  {#if error}
    <div
      class="absolute right-2 bottom-2 left-2 z-20 rounded-md border border-tool-error/30 bg-popover px-2 py-1.5 text-xs leading-4 text-tool-error shadow-md"
      role="status"
    >{error}</div>
  {/if}
</div>
