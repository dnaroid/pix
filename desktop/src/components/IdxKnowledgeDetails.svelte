<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { onMount } from "svelte";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { idxKnowledgeReason } from "../lib/idx-knowledge";
  import { createIdxPanelKnowledgeController } from "./idx-panel-knowledge-controller.svelte";
  import IdxOutput from "./IdxOutput.svelte";

  let { workspace, operationRunning, onValidateProjectFile, onOpenProjectFile }: {
    workspace: string;
    operationRunning: boolean;
    onValidateProjectFile: (path: string) => Promise<boolean>;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
  } = $props();
  let open = $state(false);
  const controller = createIdxPanelKnowledgeController({ workspace: () => workspace, operationRunning: () => operationRunning });
  const report = $derived(controller.report);
  const pendingSpecs = $derived(report?.specs.filter((row) => row.status !== "clean") ?? []);
  $effect(() => {
    workspace;
    open = false;
    controller.invalidate();
  });
  onMount(() => () => controller.dispose());

  function toggle(event: Event): void {
    open = (event.currentTarget as HTMLDetailsElement).open;
    if (open) void controller.run();
    else controller.invalidate();
  }
</script>

<details class="group/knowledge border-t border-sidebar-border/70" {open} ontoggle={toggle}>
  <summary class="flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
    <ChevronDown class="h-3 w-3 shrink-0 -rotate-90 transition-transform group-open/knowledge:rotate-0" aria-hidden="true" />
    Files needing knowledge review
  </summary>
  <div class="space-y-2 pb-1 text-xs leading-4">
    <div class="flex items-center gap-2">
      <span class="text-muted-foreground">Active specs and their declared dependencies, not Git changes.</span>
      <button class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" aria-label="Refresh knowledge details" disabled={controller.state.running || operationRunning} onclick={() => void controller.run()}><RefreshCw class={`h-3 w-3 ${controller.state.running ? "animate-spin" : ""}`} aria-hidden="true" /></button>
    </div>
    {#if controller.state.running}
      <p class="text-muted-foreground" role="status">Checking knowledge files…</p>
    {:else if controller.error}
      <p class="break-words text-tool-error" role="status">{controller.error}</p>
    {:else if report}
      {#if report.status === "error"}<p class="text-tool-warning">Check incomplete. Listed files may not cover all pending reviews.</p>{/if}
      {#each report.warnings as warning}<p class="break-words text-tool-warning">{warning}</p>{/each}
      {#if report.status === "clean"}<p class="text-tool-success">No pending knowledge review detected.</p>{/if}
      {#each pendingSpecs as row (row.path)}
        <div class="space-y-1 border-t border-sidebar-border/70 pt-2">
          <div class="break-words font-mono text-foreground"><IdxOutput text={row.path} className="text-xs" {onValidateProjectFile} {onOpenProjectFile} /></div>
          {#each row.reasons as reason}<p class={row.status === "error" ? "break-words text-tool-error" : "break-words text-tool-warning"}>{idxKnowledgeReason(reason)}</p>{/each}
          {#if row.changedPaths.length}
            <p class="text-muted-foreground">{row.reasons.includes("never-reviewed") ? "Unreviewed files" : "Changed files"} ({row.changedPaths.length})</p>
            <div class="break-words border-l border-sidebar-border pl-2 font-mono text-muted-foreground"><IdxOutput text={row.changedPaths.join("\n")} className="text-xs whitespace-pre-wrap" {onValidateProjectFile} {onOpenProjectFile} /></div>
          {/if}
        </div>
      {/each}
    {:else if operationRunning}
      <p class="text-muted-foreground">Wait for the IDX operation to finish, then refresh details.</p>
    {/if}
  </div>
</details>
