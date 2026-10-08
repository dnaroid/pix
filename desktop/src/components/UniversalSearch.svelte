<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import Mic from "@lucide/svelte/icons/mic";
  import Square from "@lucide/svelte/icons/square";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import { browserDeepgramSupported, DeepgramDictationController, type DeepgramDictationState, type DeepgramToken } from "../lib/deepgram";
  import { SearchVoiceController, insertSearchTranscript } from "../lib/search-voice-controller";
  import { pendingSearchNotice } from "../lib/search-source-deadline";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { queryUniversalSearch, SEARCH_KINDS, SEARCH_LABELS, type SearchHit, type SearchKind } from "../lib/universal-search";
  import { SearchDialogController, emptySearchDialogState, searchStatusLabel } from "../lib/search-dialog-controller";
  import { SETTINGS_SEARCH_CATALOG } from "../lib/settings-search-catalog";
  import type { AcpClient } from "../lib/acp-client";
  import type { IdxOverview, IdxCommandResult } from "../lib/idx";
  import { parseTaskDocument } from "../lib/project-tasks";
  import type { GitHistoryEntry } from "../lib/git-workflow";
  import type { SearchDialogMemory } from "../lib/search-dialog-memory";

  let { workspace, client, memory, onSelect, onPreferences, onClose }: {
    workspace: string;
    client: AcpClient | null;
    memory: SearchDialogMemory;
    onSelect: (hit: SearchHit) => Promise<void>;
    onPreferences: () => void;
    onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let query = $state("");
  let types = $state<SearchKind[]>([...SEARCH_KINDS]);
  let view = $state(emptySearchDialogState());
  const result = $derived(view.result);
  const busy = $derived(view.busy);
  const status = $derived(view.status ?? result.status);
  const searching = $derived(busy || !!result.pendingSources?.length);
  const notices = $derived(result.notices.filter(notice => !(result.pendingSources ?? []).some(source => notice === pendingSearchNotice(source))));
  let requests: SearchDialogController | undefined;
  let navigating = $state(false);
  let navigationError = $state("");
  // No row is selected until the user explicitly navigates the results.
  let active = $state(-1);
  let disposed = false;
  let composing = $state(false);
  let voice: SearchVoiceController | undefined;
  let voiceSupported = $state(false);
  let voiceState = $state<DeepgramDictationState>("idle");
  let voiceInterim = $state("");
  let voiceError = $state("");
  let submitting = $state(false);
  let submissionGeneration = 0;

  onMount(() => {
    voiceSupported = browserDeepgramSupported();
    voice = new SearchVoiceController(
      callbacks => new DeepgramDictationController(callbacks, () => invoke<DeepgramToken>("deepgram_token")),
      {
        onState: state => { voiceState = state; },
        onInterim: text => { voiceInterim = text ?? ""; },
        onError: error => { voiceError = error; },
        onFinal: text => {
          const insertion = insertSearchTranscript(query, text, input.selectionStart ?? query.length, input.selectionEnd ?? query.length);
          query = insertion.query;
          invalidate(false);
          const generation = submissionGeneration;
          void tick().then(() => {
            if (!disposed && generation === submissionGeneration && query === insertion.query) input.setSelectionRange(insertion.caret, insertion.caret);
          });
        },
      },
    );
    return () => voice?.dispose();
  });

  $effect(() => activateModalDialog(dialog, () => input));
  $effect(() => () => { disposed = true; });
  $effect(() => {
    const requestWorkspace = workspace;
    const requestClient = client;
    const requestMemory = memory;
    const restored = untrack(() => requestMemory.restore(requestWorkspace, requestClient));
    let latestState = restored.view;
    const next = new SearchDialogController((requestQuery, requestTypes, signal, onUpdate) => queryUniversalSearch({
        local: requestClient ? (request, signal) => requestClient.searchQuery(request, signal) : undefined,
        overview: workspace => invoke<IdxOverview>("idx_overview", { workspace }),
        index: (workspace, query) => invoke<IdxCommandResult>("idx_query", { request: { workspace, query } }),
        tasks: async workspace => parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace })),
        commits: (workspace, query) => invoke<GitHistoryEntry[]>("git_search_history", { workspace, query }),
        ...(client ? { commitHybrid: (cwd: string, query: string, signal: AbortSignal) => client.searchCommits({ cwd, query, limit: 20 }, signal) } : {}),
      }, requestWorkspace, requestQuery, requestTypes, SETTINGS_SEARCH_CATALOG.map(field => ({ ...field, description: field.description ?? "" })), signal, onUpdate),
      requestClient ? signal => requestClient.searchConfig(requestWorkspace, {}, signal) : undefined,
      nextState => untrack(() => {
        const focusedId = active >= 0 ? view.result.results[active]?.id : undefined;
        latestState = nextState; view = nextState;
        const nextIndex = focusedId ? nextState.result.results.findIndex(hit => hit.id === focusedId) : -1;
        active = nextIndex >= 0 ? nextIndex : -1;
      }), 1500, restored.view);
    requests = next;
    untrack(() => {
      query = restored.query; types = restored.types; view = restored.view;
      active = restored.active >= 0 && restored.active < restored.view.result.results.length ? restored.active : -1;
      navigationError = ""; next.start();
    });
    return () => {
      submissionGeneration++;
      submitting = false;
      voice?.cancel();
      next.dispose();
      untrack(() => requestMemory.save(requestWorkspace, requestClient, { query, types: [...types], view: latestState, active }));
      if (requests === next) requests = undefined;
    };
  });

  function invalidate(cancelVoice = true) {
    if (cancelVoice) {
      submissionGeneration++;
      submitting = false;
      voice?.cancel();
      voiceError = "";
    }
    requests?.invalidate();
    active = -1;
    navigationError = "";
  }
  async function submit() {
    if (navigating || busy || composing || submitting) return;
    const generation = submissionGeneration;
    const currentRequests = requests;
    submitting = true;
    const finalized = voice ? await voice.stop() : true;
    if (!finalized || disposed || generation !== submissionGeneration || requests !== currentRequests) return;
    submitting = false;
    active = -1;
    navigationError = "";
    void currentRequests?.submit(query, types);
  }
  async function toggleVoice() {
    const generation = submissionGeneration;
    voiceError = "";
    requests?.invalidate();
    await voice?.toggle();
    if (!disposed && generation === submissionGeneration) input.focus();
  }
  function close() {
    submissionGeneration++;
    voice?.cancel();
    onClose();
  }
  function toggle(kind: SearchKind) {
    types = types.includes(kind) ? types.filter(value => value !== kind) : [...types, kind];
    invalidate();
  }
  async function choose(hit: SearchHit) {
    if (navigating) return;
    navigating = true;
    navigationError = "";
    try { await onSelect(hit); if (!disposed) close(); }
    catch (error) { if (!disposed) navigationError = error instanceof Error ? error.message : "The search target is unavailable."; }
    finally { if (!disposed) navigating = false; }
  }
  function handleKey(event: KeyboardEvent) {
    if (event.isComposing || navigating) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const length = result.results.length;
      if (length === 0) { active = -1; return; }
      active = active < 0 || active >= length
        ? (event.key === "ArrowDown" ? 0 : length - 1)
        : (active + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
      dialog.querySelector(`[data-search-result="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      submit();
    }
  }
</script>

<dialog bind:this={dialog} aria-label="Search current project" onkeydown={handleKey}
  oncancel={(event) => { event.preventDefault(); close(); }}
  onclick={(event) => { if (event.target === dialog) close(); }}
  class="fixed inset-0 z-50 m-auto h-screen max-h-none w-screen max-w-none place-items-start bg-transparent px-5 pt-[12vh] text-foreground backdrop:bg-overlay open:grid">
  <section class="mx-auto flex max-h-[72vh] w-[680px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
    <form onsubmit={(event) => { event.preventDefault(); submit(); }} class="flex items-center gap-2 border-b border-border px-3 py-2">
      <Search class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input bind:this={input} bind:value={query} oninput={() => invalidate()} oncompositionstart={() => { composing = true; invalidate(); }} oncompositionend={() => { composing = false; }} type="text" maxlength="2048" aria-label="Search settings, sessions, tasks, commits, code and knowledge"
        placeholder="Search this project…" class="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none" />
      {#if voiceSupported}
        <button type="button" onclick={() => void toggleVoice()} disabled={navigating || submitting || composing} aria-label={voiceState === "idle" ? "Voice search" : "Stop voice input"} aria-pressed={voiceState !== "idle"} title={voiceState === "idle" ? "Voice search · Deepgram" : "Stop voice input"}
          class="rounded p-1.5 hover:bg-chrome-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring {voiceState !== 'idle' ? 'text-primary' : 'text-muted-foreground'}">
          {#if voiceState === "starting"}<LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" />{:else if voiceState === "listening"}<Square class="h-4 w-4" />{:else}<Mic class="h-4 w-4" />{/if}
        </button>
      {/if}
      <button type="submit" disabled={(!query.trim() && voiceState === "idle") || !types.length || busy || navigating || submitting} class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring">Search</button>
      <button type="button" aria-label="Close search" onclick={close} class="rounded p-1 text-muted-foreground hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring"><X class="h-4 w-4" /></button>
    </form>
    {#if voiceState !== "idle" || voiceError}
      <div class="border-b border-border px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
        {#if voiceError}<p class="text-destructive" role="alert">{voiceError}</p>{:else}<p role="status">{voiceState === "starting" ? "Starting microphone…" : "Listening…"} {voiceInterim}</p>{/if}
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2" aria-label="Result types">
      {#each SEARCH_KINDS as kind}
        <button type="button" aria-pressed={types.includes(kind)} onclick={() => toggle(kind)}
          data-search-kind={kind}
          class="search-category-filter rounded border px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">{SEARCH_LABELS[kind]}</button>
      {/each}
      <span class="ml-auto truncate text-xs text-muted-foreground" title={workspace}>Current project</span>
    </div>
    <div class="overflow-auto p-1.5" aria-busy={searching} aria-label="Search results">
      {#if !query.trim()}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">Search this project.</p>
      {:else if !view.submitted}<p class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">{types.length ? 'Press Search or Enter to search.' : 'Select at least one result type.'}</p>
      {:else if searching && !result.results.length}<p class="px-3 py-6 text-center text-xs text-muted-foreground">Waiting for results…</p>
      {:else if !result.results.length && notices.length}<p class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">No results. Check search details.</p>
      {:else if !result.results.length}<p class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">{types.length ? 'No results.' : 'Select at least one result type.'}</p>{/if}
      {#each result.results as hit, index (hit.id)}
        <button type="button" data-search-result={index} data-active={index === active ? "true" : undefined}
          disabled={navigating} onclick={() => void choose(hit)}
          class="search-result mb-0.5 block w-full rounded-md px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring">
          <div class="flex items-baseline gap-2"><span class="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span><span data-search-kind={hit.kind} class="search-category-badge shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium">{SEARCH_LABELS[hit.kind]}</span></div>
          <p class="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{hit.snippet}</p>
        </button>
      {/each}
    </div>
    <footer class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
      {#if navigationError}<p class="text-destructive" role="alert">{navigationError}</p>{/if}
      <div class="flex items-center justify-between gap-3">
        <span class="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
          {#if searching}<LoaderCircle aria-hidden="true" class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span>Searching…{result.results.length ? ` · ${result.results.length} results` : ""}</span>
          {:else if view.submitted}<span>{result.results.length} results</span>{:else}<span>Enter to search</span>{/if}
        </span>
        <button type="button" onclick={onPreferences} class="shrink-0 rounded px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Search settings</button>
      </div>
      <details class="mt-1">
        <summary class="w-fit cursor-pointer rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Search details{notices.length || view.statusError || status?.error || status?.warning ? " · warnings" : ""}</summary>
        <div class="space-y-1 pt-2">
          {#each notices as notice}<p>{notice}</p>{/each}
          {#if result.pendingSources?.length}<p>Waiting for {result.pendingSources.join(", ")}.</p>{/if}
          {#if types.includes("commits")}<p>Commits: BM25 + optional semantic search · all ancestors of current HEAD</p>
            <p>The saved IDX provider may receive commit messages and queries. The first search may index the full HEAD history.</p>{/if}
          <p>{view.statusError ?? (status ? searchStatusLabel(status) : client ? 'Search status: loading…' : 'Session search: backend disconnected')}</p>
          {#if status?.error}<p>{status.error}</p>{/if}
          {#if status?.warning}<p>{status.warning}</p>{/if}
          <p>Local BM25 · {status?.enabled && status.keyAvailable ? 'semantic settings enabled' : 'semantic settings are opt-in'} · IDX hybrid uses the project provider and may refresh the index</p>
          {#if voiceSupported}<p>Voice input sends microphone audio to Deepgram. It fills the query; press Search or Enter to search.</p>{/if}
        </div>
      </details>
    </footer>
  </section>
</dialog>

<style>
  [data-search-kind="settings"] { --category-color: var(--tool-inspect); }
  [data-search-kind="sessions"] { --category-color: var(--tool-search); }
  [data-search-kind="tasks"] { --category-color: var(--tool-skill); }
  [data-search-kind="commits"] { --category-color: var(--tool-agent); }
  [data-search-kind="code"] { --category-color: var(--tool-execute); }
  [data-search-kind="knowledge"] { --category-color: var(--tool-mutation); }

  .search-category-filter,
  .search-category-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted-foreground);
    border-color: var(--border);
    background: transparent;
  }
  .search-category-filter::before,
  .search-category-badge::before {
    content: "";
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--category-color);
  }
  .search-category-filter[aria-pressed="true"] {
    color: var(--foreground);
    border-color: color-mix(in srgb, var(--category-color) 40%, var(--border));
    background: var(--panel-strong);
  }
  .search-category-filter:hover {
    background: var(--chrome-hover);
  }
  .search-category-badge {
    color: var(--muted-foreground);
    background: var(--panel);
  }

  /* Quiet selection, smooth inset hover outline: no clipped left-border corners. */
  .search-result,
  .search-result .search-category-badge {
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .search-result[data-active="true"] {
    background: var(--panel-selected);
  }
  .search-result:focus-visible {
    outline-color: var(--ring);
  }
  @media (hover: hover) {
    .search-result:hover:not(:disabled) {
      background: var(--panel-hover);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border) 55%, var(--primary));
    }
    .search-result:hover:not(:disabled) .search-category-badge {
      color: var(--foreground);
      border-color: color-mix(in srgb, var(--category-color) 35%, var(--border));
      background: var(--panel-strong);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .search-result,
    .search-result .search-category-badge {
      transition: none;
    }
  }
</style>
