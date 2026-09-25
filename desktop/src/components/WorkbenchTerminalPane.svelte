<script lang="ts">
  import { onMount } from "svelte";
  import { createPackageScriptsController } from "./package-scripts-controller.svelte";
  import TerminalSessionsPane, { type TerminalSurfaceHandle } from "./TerminalSessionsPane.svelte";

  let { workspace }: { workspace: string } = $props();

  let terminalView = $state<TerminalSurfaceHandle | null>(null);
  const controller = createPackageScriptsController({
    workspace: () => workspace,
    terminalView: () => terminalView,
  });
  const terminals = $derived(controller.terminals);
  const activeTerminalId = $derived(controller.activeTerminalId);
  const activeTerminal = $derived(controller.activeTerminal);
  const loading = $derived(controller.loading);
  const error = $derived(controller.error);
  const startingScript = $derived(controller.startingScript);
  const terminalActionId = $derived(controller.terminalActionId);

  onMount(controller.start);

  export async function openTerminal(command: string): Promise<void> {
    await controller.openShellTerminal(command);
  }
</script>

<section class="relative h-full min-h-0 min-w-0 w-full overflow-hidden bg-code" aria-label="Terminal">
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
    onSelectTerminal={controller.selectTerminal}
    onOpenShellTerminal={controller.openShellTerminal}
    onWriteTerminal={controller.writeTerminal}
    onResizeTerminal={controller.resizeTerminal}
    onStopTerminal={controller.stopTerminal}
    onRestartTerminal={controller.restartTerminal}
    onCloseTerminal={controller.closeTerminal}
  />
</section>
