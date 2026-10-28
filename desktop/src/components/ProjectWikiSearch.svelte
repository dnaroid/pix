<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import FileText from "@lucide/svelte/icons/file-text";
  import { untrack, type Snippet } from "svelte";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { iconButtonClass } from "../lib/icon-button";
  import { queryNativeRepository } from "../lib/native-repository-search";
  import { queryProjectWiki } from "../lib/project-wiki-search";
  import { SearchDialogController, emptySearchDialogState } from "../lib/search-dialog-controller";
  import { readSearchSourceSelection, SEARCH_SOURCE_SELECTION_CHANGED } from "../lib/search-source-selection";
  import { pendingSearchNotice } from "../lib/search-source-deadline";
  import type { ProjectFileLineRange } from "../lib/project-files";

  let { workspace, path, activePath, onOpenFile, children }: {
    workspace: string;
    path: string;
    activePath: string | null;
    onOpenFile: (path: string, searchRange?: ProjectFileLineRange) => void;
    children: Snippet;
  } = $props();
  let query = $state("");
  let composing = $state(false);
  let view = $state(emptySearchDialogState());
  let input: HTMLInputElement;
  let results: HTMLDivElement;
  let requests: SearchDialogController | undefined;
  // Parent prop spreads refresh during background polling. Compare primitive
  // targets before the ownership effect so equal targets retain the search.
  const searchWorkspace = $derived(workspace);
  const searchDirectory = $derived(path);
  const searching = $derived(query.trim().length > 0);
  const busy = $derived(view.busy || !!view.result.pendingSources?.length);
  const notices = $derived(view.result.notices.filter(notice =>
    !view.result.pendingSources?.some(source => notice === pendingSearchNotice(source))));
  const statusText = $derived.by(() => {
    if (busy) return "Searching Wiki…";
    if (!view.submitted) return "Press Enter to search Wiki.";
    const count = view.result.results.length;
    if (count) return `${count} ${count === 1 ? "page" : "pages"}`;
    return notices.length ? "No results. See search details below." : "No matching pages.";
  });

  $effect(() => {
    const target = searchWorkspace, directory = searchDirectory;
    const diagnostics = createDiagnosticLogger(() => ({ workspace: target }));
    const reported = new Set<string>();
    const next = new SearchDialogController(
      (query, _types, signal, update) => queryProjectWiki({
        selection: readSearchSourceSelection,
        repository: (workspace, request, signal) => queryNativeRepository(invoke, workspace, request, signal),
      }, target, directory, query, signal, update),
      undefined,
      state => {
        view = state;
        for (const notice of state.result.notices) {
          if (reported.has(notice) || state.result.pendingSources?.some(source => notice === pendingSearchNotice(source))) continue;
          reported.add(notice);
          diagnostics.report(notice, "wiki:search-notice");
        }
      },
    );
    requests = next;
    untrack(() => { query = ""; view = emptySearchDialogState(); });
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace?: string; global?: boolean }>).detail;
      if (event.type !== SEARCH_SOURCE_SELECTION_CHANGED || detail?.global || detail?.workspace === target) next.invalidate();
    };
    window.addEventListener(SEARCH_SOURCE_SELECTION_CHANGED, invalidate);
    window.addEventListener("pix-semantic-config-changed", invalidate);
    return () => {
      next.dispose();
      window.removeEventListener(SEARCH_SOURCE_SELECTION_CHANGED, invalidate);
      window.removeEventListener("pix-semantic-config-changed", invalidate);
      if (requests === next) requests = undefined;
    };
  });

  function clear(): void {
    query = "";
    requests?.invalidate();
    input.focus();
  }
  function openResult(hit: ProjectFileLineRange & { path: string }): void {
    // Opening Preview must not invalidate or re-submit the sidebar search.
    onOpenFile(hit.path, { startLine: hit.startLine, endLine: hit.endLine });
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape" && searching) {
      event.preventDefault(); event.stopPropagation(); clear();
    } else if (event.key === "ArrowDown" && event.target === input) {
      const first = results?.querySelector<HTMLButtonElement>("[data-wiki-result]");
      if (first) { event.preventDefault(); first.focus(); }
    }
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  <form class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3" role="search" aria-label="Wiki search" onsubmit={(event) => { event.preventDefault(); if (!composing) void requests?.submit(query, ["knowledge"]); }}>
    <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <input bind:this={input} bind:value={query} type="search" placeholder="Search Wiki…" aria-label="Search Wiki" title="Hybrid Knowledge search · Enter to search" class="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none" oninput={() => requests?.invalidate()} onkeydown={keydown} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} />
    {#if searching}
      <button type="button" class={iconButtonClass("sm", "panel")} aria-label="Clear Wiki search" title="Clear search (Escape)" onclick={clear} onkeydown={keydown}><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    {/if}
  </form>
  <div class="min-h-0 flex-1 overflow-y-auto" class:hidden={!searching} bind:this={results} aria-busy={busy}>
    <div class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
      {#if busy}<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{/if}
      <span>{statusText}</span>
    </div>
    {#each view.result.results as hit (hit.id)}
      {#if hit.kind === "knowledge"}
        <button type="button" data-wiki-result class="flex w-full min-w-0 gap-2 px-3 py-2 text-left hover:bg-panel-hover focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-ring" class:bg-panel-selected={hit.path === activePath} aria-current={hit.path === activePath ? "page" : undefined} title={hit.path} onclick={() => openResult(hit)} onkeydown={keydown}>
          <FileText class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium">{hit.title}</span>
            <span class="block truncate font-mono text-xs text-muted-foreground">{hit.path.slice(path.length + 1)}</span>
            <span class="mt-1 line-clamp-3 break-words text-xs text-muted-foreground">{hit.snippet}</span>
          </span>
        </button>
      {/if}
    {/each}
    {#if notices.length}
      <div class="border-t border-border px-3 py-2 text-xs text-muted-foreground" role="status">
        {#each notices as notice}<p class="break-words py-1">{notice}</p>{/each}
      </div>
    {/if}
  </div>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden" class:hidden={searching}>
    {@render children()}
  </div>
</div>
