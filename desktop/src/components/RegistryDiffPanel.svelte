<script lang="ts">
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { structuredDiffModel } from "../lib/diff";
  import type { RegistryDiffState } from "../lib/registry";
  import DiffView from "./DiffView.svelte";

  let {
    diff,
    onClose,
    onRetry,
  }: {
    diff: RegistryDiffState;
    onClose: () => void;
    onRetry?: () => void;
  } = $props();

  const target = $derived(diff.target);
  const typeLabel = $derived(target.type === "skill" ? "SKILL" : "AGENT");

  let rootElement = $state<HTMLElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  let restoreFocusElement: HTMLElement | null = null;

  onMount(() => {
    restoreFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton?.focus();
    return () => {
      // Return keyboard focus to the Diff trigger when the view closes,
      // but never steal focus that moved somewhere else meanwhile.
      if (document.activeElement === null || (rootElement?.contains(document.activeElement) ?? false)) {
        restoreFocusElement?.focus();
      }
    };
  });

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  function fileTone(oldText: string | null, newText: string | null): string {
    if (oldText === null) return "text-tool-success";
    if (newText === null) return "text-tool-error";
    return "text-muted-foreground";
  }

  function fileDirectionLabel(oldText: string | null, newText: string | null): string {
    if (oldText === null) return "Added locally";
    if (newText === null) return "Removed locally";
    return "Changed";
  }

  function typeTone(type: "skill" | "agent"): string {
    if (type === "skill") return "border-tool-info/25 bg-tool-info/5 text-tool-info";
    return "border-primary/25 bg-primary/5 text-primary";
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<section
  class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
  aria-label={`Registry diff: ${target.name}`}
  bind:this={rootElement}
>
  <header class="flex min-h-9 min-w-0 flex-wrap items-center gap-2 border-b border-sidebar-border bg-panel px-2 py-1">
    <FileDiff class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <strong class="min-w-0 truncate text-xs font-medium text-foreground" title={target.name}>{target.name}</strong>
    <span class={[
      "shrink-0 rounded border px-1 py-px font-mono text-xs font-semibold tracking-wide",
      typeTone(target.type),
    ]}>{typeLabel}</span>
    <span
      class="shrink-0 rounded border border-border bg-muted/20 px-1.5 py-px text-xs font-medium text-muted-foreground"
      title="Old side is the registry copy; new side is the local project copy."
    >Registry → Local</span>
    <button
      class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      title="Close registry diff"
      aria-label="Close registry diff"
      onclick={onClose}
      bind:this={closeButton}
    >
      <X class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </header>
  <p class="shrink-0 border-b border-sidebar-border/70 bg-panel px-2 py-1 text-xs text-muted-foreground">
    Read-only comparison. The old side is the registry copy; the new side is the local project copy.
  </p>

  <div class="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
    {#if diff.phase === "loading"}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" role="status">
        <RefreshCw class="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading diff for {target.name}…
      </div>
    {:else if diff.phase === "error"}
      <div class="flex flex-col items-start gap-2 rounded-md border border-tool-error/30 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error" role="alert">
        <span>{diff.error}</span>
        {#if onRetry}
          <button
            class="inline-flex h-7 items-center gap-1.5 rounded-md border border-tool-error/30 bg-panel-strong px-2.5 text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
            type="button"
            onclick={onRetry}
          >
            <RefreshCw class="h-3 w-3" aria-hidden="true" />
            Try again
          </button>
        {/if}
      </div>
    {:else if diff.files.length === 0}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">No differences between the registry and local copies.</div>
    {:else}
      <div class="min-w-0 space-y-1">
        {#each diff.files as file (file.path)}
          <div class="min-w-0">
            {#if !file.notice && (file.oldText === null || file.newText === null)}
              <p class={[
                "px-0.5 text-xs font-medium",
                fileTone(file.oldText, file.newText),
              ]}>
                {fileDirectionLabel(file.oldText, file.newText)}
              </p>
            {/if}
            {#if file.notice}
              <div class="mt-1 flex items-start gap-2 rounded-md border border-tool-warning/30 bg-tool-warning/5 px-2.5 py-2 text-xs leading-4 text-tool-warning">
                <TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span class="min-w-0 break-all">{file.notice}</span>
              </div>
            {:else}
              <!-- A null side is an added or removed file; structuredDiffModel renders it one-sided. -->
              <DiffView model={structuredDiffModel({ path: file.path, oldText: file.oldText, newText: file.newText ?? "" })} />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
