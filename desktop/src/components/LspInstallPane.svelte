<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CodeXml from "@lucide/svelte/icons/code-xml";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { LspInstallerState } from "../app/lsp-onboarding.svelte";

  let { state, onRetry }: { state: LspInstallerState; onRetry: () => void } = $props();
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="LSP installation">
  <header class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3">
    <CodeXml class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
    <span class="min-w-0 truncate text-xs font-medium text-foreground">{state.suggestion.serverLabel}</span>
    <span class="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{state.suggestion.languageLabel}</span>
  </header>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-3xl">
      <div class="mb-4 flex items-start gap-3">
        {#if state.phase === "success"}
          <CircleCheck class="mt-0.5 h-5 w-5 shrink-0 text-tool-success" aria-hidden="true" />
        {:else if state.phase === "error"}
          <TriangleAlert class="mt-0.5 h-5 w-5 shrink-0 text-tool-error" aria-hidden="true" />
        {:else}
          <LoaderCircle class="mt-0.5 h-5 w-5 shrink-0 animate-spin text-tool-info motion-reduce:animate-none" aria-hidden="true" />
        {/if}
        <div class="min-w-0">
          <h2 class="text-sm font-medium text-foreground">
            {#if state.phase === "installing"}
              Installing {state.suggestion.serverLabel}
            {:else if state.phase === "success"}
              LSP installed and registered
            {:else}
              LSP installation failed
            {/if}
          </h2>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">
            {#if state.phase === "success"}
              Future edits of {state.suggestion.languageLabel} files can use this language server. Continue the agent when you are ready.
            {:else if state.phase === "installing"}
              The conversation is paused while Pix installs this trusted language server. Pix will not continue the agent automatically.
            {:else}
              Triggered by <span class="font-mono">{state.suggestion.path}</span>.
            {/if}
          </p>
        </div>
      </div>

      {#if state.error}
        <pre class="mb-3 max-h-80 overflow-auto rounded-md border border-tool-error/25 bg-tool-error/5 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-tool-error">{state.error}</pre>
        <button class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-2.5 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onRetry}>
          <RotateCw class="h-3.5 w-3.5" aria-hidden="true" />Retry
        </button>
      {/if}

      {#if state.output}
        <pre class="max-h-[55vh] overflow-auto rounded-md border border-code-border bg-code px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-code-foreground">{state.output}</pre>
      {/if}
    </div>
  </div>
</section>
