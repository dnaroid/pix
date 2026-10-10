<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Search from "@lucide/svelte/icons/search";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
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
  import { SearchIntentController } from "../lib/search-intent-controller";
  import { linkRagCitations, ragRequest, retrieveRagHits } from "../lib/search-rag";
  import MarkdownText from "./MarkdownText.svelte";
  import type { SearchSources, UnifiedSearchResult } from "../lib/universal-search";

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
  let mode = $state<"search" | "auto" | "rag">("auto");
  let intentBusy = $state(false);
  let intentNotice = $state("");
  const intentController = new SearchIntentController();
  let ragPhase = $state<"idle" | "retrieving" | "generating" | "done" | "stopped" | "error">("idle");
  let ragAnswer = $state("");
  let ragModel = $state("");
  let ragError = $state("");
  let ragRetrieved = $state<UnifiedSearchResult | null>(null);
  let ragHits = $state<SearchHit[]>([]);
  let ragSourceIds = $state<string[]>([]);
  let ragController: AbortController | undefined;
  let ragSearch: ((q: string, t: readonly SearchKind[], signal: AbortSignal, onUpdate: (result: UnifiedSearchResult) => void) => Promise<UnifiedSearchResult>) | undefined;
  const ragReferences = $derived(ragSourceIds.flatMap(id => {
    const hit = ragHits.find(hit => hit.id === id);
    return hit ? [hit] : [];
  }));
  const ragMarkdown = $derived(linkRagCitations(ragAnswer, ragReferences.length));
  let types = $state<SearchKind[]>([...SEARCH_KINDS]);
  let view = $state(emptySearchDialogState());
  const result = $derived(view.result);
  const busy = $derived(view.busy);
  const status = $derived(view.status ?? result.status);
  const ragActive = $derived(ragPhase === "retrieving" || ragPhase === "generating");
  const searching = $derived(busy || intentBusy || ragActive || !!result.pendingSources?.length);
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
    return () => { voice?.dispose(); intentController.cancel(); ragController?.abort(); };
  });

  $effect(() => activateModalDialog(dialog, () => input));
  $effect(() => () => { disposed = true; intentController.cancel(); ragController?.abort(); });
  $effect(() => {
    const requestWorkspace = workspace;
    const requestClient = client;
    const requestMemory = memory;
    const restored = untrack(() => requestMemory.restore(requestWorkspace, requestClient));
    let latestState = restored.view;
    const searchSources: SearchSources = {
        local: requestClient ? (request, signal) => requestClient.searchQuery(request, signal) : undefined,
        overview: workspace => invoke<IdxOverview>("idx_overview", { workspace }),
        index: (workspace, query) => invoke<IdxCommandResult>("idx_query", { request: { workspace, query } }),
        tasks: async workspace => parseTaskDocument(await invoke<unknown>("read_project_tasks", { workspace })),
        taskAttachmentNames: workspace => invoke<Record<string, string[]>>("read_project_task_attachment_names", { workspace }),
        ...(requestClient ? { taskSemantic: (cwd: string, query: string, signal: AbortSignal) =>
          requestClient.searchSemanticTasks({ cwd, query, limit: 30 }, signal) } : {}),
        commits: (workspace, query) => invoke<GitHistoryEntry[]>("git_search_history", { workspace, query }),
        ...(requestClient ? { commitHybrid: (cwd: string, query: string, signal: AbortSignal) => requestClient.searchCommits({ cwd, query, limit: 20 }, signal) } : {}),
      };
    const execute = (requestQuery: string, requestTypes: readonly SearchKind[], signal: AbortSignal, onUpdate: (result: UnifiedSearchResult) => void) =>
      queryUniversalSearch(searchSources, requestWorkspace, requestQuery, requestTypes,
        SETTINGS_SEARCH_CATALOG.map(field => ({ ...field, description: field.description ?? "" })), signal, onUpdate);
    ragSearch = execute;
    const next = new SearchDialogController(execute,
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
      mode = restored.mode ?? "auto";
      intentNotice = restored.intentNotice ?? "";
      active = restored.active >= 0 && restored.active < restored.view.result.results.length ? restored.active : -1;
      navigationError = ""; next.start();
    });
    return () => {
      submissionGeneration++;
      submitting = false;
      intentController.cancel();
      intentBusy = false;
      ragController?.abort();
      ragController = undefined;
      voice?.cancel();
      next.dispose();
      untrack(() => requestMemory.save(requestWorkspace, requestClient, {
        query, types: [...types], view: latestState, active, mode,
        intentNotice,
      }));
      if (ragSearch === execute) ragSearch = undefined;
      if (requests === next) requests = undefined;
    };
  });

  function invalidate(cancelVoice = true) {
    intentController.cancel();
    ragController?.abort();
    ragController = undefined;
    ragPhase = "idle";
    ragAnswer = "";
    ragModel = "";
    ragError = "";
    ragRetrieved = null;
    ragHits = [];
    ragSourceIds = [];
    intentBusy = false;
    intentNotice = "";
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
    if (navigating || busy || intentBusy || composing || submitting) return;
    const generation = submissionGeneration;
    const currentRequests = requests;
    submitting = true;
    const finalized = voice ? await voice.stop() : true;
    if (!finalized || disposed || generation !== submissionGeneration || requests !== currentRequests) return;
    submitting = false;
    if (!query.trim() || !types.length) return;
    active = -1;
    navigationError = "";
    if (mode === "rag") { void runRag(); return; }
    if (mode === "auto") {
      currentRequests?.invalidate();
      intentNotice = "";
      intentBusy = true;
      const requestClient = client;
      const requestWorkspace = workspace;
      const decision = await intentController.classify(signal => requestClient
        ? requestClient.searchIntent({ cwd: requestWorkspace, query: query.trim() }, signal)
        : Promise.resolve({ intent: "search" as const, fallback: true }));
      if (disposed || generation !== submissionGeneration || requests !== currentRequests
        || requestClient !== client || requestWorkspace !== workspace || !decision) return;
      intentBusy = false;
      intentNotice = decision.fallback ? "Jev unavailable; using regular Search." : "";
      if (decision.intent === "ask") { void runRag(); return; }
    }
    void currentRequests?.submit(query, types);
  }
  async function runRag(): Promise<void> {
    ragController?.abort();
    requests?.invalidate();
    const owner = new AbortController();
    ragController = owner;
    const active = () => !disposed && ragController === owner && !owner.signal.aborted;
    const requestClient = client;
    const requestWorkspace = workspace;
    const runSearch = ragSearch;
    ragAnswer = ""; ragModel = ""; ragError = ""; ragRetrieved = null;
    ragHits = []; ragSourceIds = []; ragPhase = "retrieving";
    try {
      if (!requestClient || !runSearch) throw new Error("RAG requires a connected project.");
      const hits = await retrieveRagHits(
        onUpdate => runSearch(query.trim(), types, owner.signal, onUpdate),
        owner.signal,
        next => { if (active() && ragPhase === "retrieving") ragRetrieved = next; },
      );
      if (!active() || client !== requestClient || workspace !== requestWorkspace) return;
      ragHits = hits;
      if (!hits.length) { ragError = "No relevant project sources found. Try another query or select more sources."; ragPhase = "done"; return; }
      ragPhase = "generating";
      const response = await requestClient.searchRag(
        ragRequest(requestWorkspace, query.trim(), hits, crypto.randomUUID()),
        update => {
          if (!active()) return;
          if (update.sourceIds) ragSourceIds = [...update.sourceIds];
          if (update.text) ragAnswer += update.text;
        },
        owner.signal,
      );
      if (!active()) return;
      ragAnswer = response.answer;
      ragSourceIds = [...response.sourceIds];
      ragModel = response.modelRef;
      ragPhase = "done";
    } catch {
      if (!active()) return;
      ragError = "RAG generation unavailable. Check the selected model, credentials and search sources.";
      ragPhase = "error";
    } finally {
      if (ragController === owner) ragController = undefined;
    }
  }
  function stopRag() {
    ragController?.abort();
    ragController = undefined;
    ragPhase = "stopped";
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
    intentController.cancel();
    ragController?.abort();
    voice?.cancel();
    onClose();
  }
  function toggle(kind: SearchKind) {
    types = types.includes(kind) ? types.filter(value => value !== kind) : [...types, kind];
    invalidate();
  }
  function selectMode(next: "search" | "auto" | "rag") {
    if (mode === next) return;
    mode = next;
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
  function handleRagCitationClick(event: MouseEvent) {
    const anchor = event.target instanceof Element ? event.target.closest("a[data-markdown-anchor]") : null;
    const match = /^pix-rag-source-(\d+)$/u.exec(anchor?.getAttribute("data-markdown-anchor") ?? "");
    if (!match) return;
    const hit = ragReferences[Number(match[1]) - 1];
    if (!hit) return;
    event.preventDefault();
    void choose(hit);
  }
  function attachRagCitationLinks(node: HTMLElement) {
    node.addEventListener("click", handleRagCitationClick);
    return { destroy: () => node.removeEventListener("click", handleRagCitationClick) };
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
      <input bind:this={input} bind:value={query} oninput={() => invalidate()} oncompositionstart={() => { composing = true; invalidate(); }} oncompositionend={() => { composing = false; }} type="text" maxlength="2048"
        aria-label={mode === "rag" ? "Ask about this project" : "Search settings, sessions, tasks, commits, code and knowledge"}
        placeholder={mode === "rag" ? "Ask about this project…" : "Search this project…"}
        class="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none" />
      {#if voiceSupported}
        <button type="button" onclick={() => void toggleVoice()} disabled={navigating || submitting || composing} aria-label={voiceState === "idle" ? "Voice search" : "Stop voice input"} aria-pressed={voiceState !== "idle"} title={voiceState === "idle" ? "Voice search · Deepgram" : "Stop voice input"}
          class="rounded p-1.5 hover:bg-chrome-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring {voiceState !== 'idle' ? 'text-primary' : 'text-muted-foreground'}">
          {#if voiceState === "starting"}<LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" />{:else if voiceState === "listening"}<Square class="h-4 w-4" />{:else}<Mic class="h-4 w-4" />{/if}
        </button>
      {/if}
      {#if ragActive}
        <button type="button" onclick={stopRag}
          class="rounded border border-border px-3 py-1 text-xs hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring">Stop</button>
      {:else}
        <button type="submit" disabled={(!query.trim() && voiceState === "idle") || !types.length || busy || intentBusy || navigating || submitting} class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring">{mode === "rag" ? "Ask" : mode === "auto" ? "Go" : "Search"}</button>
      {/if}
      <button type="button" aria-label="Close search" onclick={close} class="rounded p-1 text-muted-foreground hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring"><X class="h-4 w-4" /></button>
    </form>
    {#if voiceState !== "idle" || voiceError}
      <div class="border-b border-border px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
        {#if voiceError}<p class="text-destructive" role="alert">{voiceError}</p>{:else}<p role="status">{voiceState === "starting" ? "Starting microphone…" : "Listening…"} {voiceInterim}</p>{/if}
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
      <div class="flex items-center gap-1" role="group" aria-label="Search mode">
        {#each [{ id: "auto", label: "Auto" }, { id: "search", label: "Search" }, { id: "rag", label: "RAG" }] as option}
          <button type="button" aria-pressed={mode === option.id} onclick={() => selectMode(option.id as "search" | "auto" | "rag")}
            class="rounded px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring {mode === option.id ? 'bg-panel-selected text-foreground' : 'text-muted-foreground hover:bg-chrome-hover'}">{option.label}</button>
        {/each}
      </div>
      {#if mode === "auto"}<span class="text-xs text-muted-foreground">Submitted query sent to OpenRouter; RAG may send source excerpts to the answer model</span>
      {:else if mode === "rag"}<span class="text-xs text-muted-foreground">Retrieved excerpts sent to the configured answer model</span>{/if}
    </div>
    <div class="overflow-auto p-1.5" aria-busy={searching} aria-label="Search results">
      {#if intentBusy}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">Jev is choosing Search or RAG…</p>
      {:else if ragPhase !== "idle"}
        <div class="space-y-3 px-3 py-3" aria-label="RAG answer">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-foreground">RAG answer</span>
            {#if ragModel}<span class="truncate font-mono text-xs text-muted-foreground">{ragModel}</span>{/if}
            {#if ragActive}<LoaderCircle class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />{/if}
          </div>
          {#if ragPhase === "retrieving"}
            <p class="text-xs text-muted-foreground" role="status">Retrieving project evidence…{ragRetrieved?.results.length ? ` · ${ragRetrieved.results.length} candidates` : ""}</p>
          {:else if ragPhase === "generating" && !ragAnswer}
            <p class="text-xs text-muted-foreground" role="status">Generating answer from retrieved sources…</p>
          {/if}
          {#if ragAnswer}
            <div class="text-sm leading-6 text-foreground" aria-live="polite" use:attachRagCitationLinks>
              <MarkdownText text={ragMarkdown} compact dense headingAnchors />
            </div>
          {/if}
          {#if ragError}<p class="text-xs text-tool-error" role="alert">{ragError}</p>{/if}
          {#if ragPhase === "stopped"}<p class="text-xs text-muted-foreground" role="status">Generation stopped.</p>{/if}
          {#if ragReferences.length}
            <div class="border-t border-border pt-2" aria-label="RAG sources">
              <p class="mb-1 text-xs font-semibold text-foreground">Sources ({ragReferences.length})</p>
              {#each ragReferences as hit, index (hit.id)}
                <button type="button" disabled={navigating} onclick={() => void choose(hit)}
                  class="mb-0.5 flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-chrome-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring">
                  <span class="shrink-0 font-medium text-primary">[{index + 1}]</span>
                  <span class="min-w-0 flex-1 truncate text-foreground" title={hit.title}>{hit.title}</span>
                  <span class="shrink-0 text-muted-foreground">{SEARCH_LABELS[hit.kind]}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if !query.trim()}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">Search this project.</p>
      {:else if !view.submitted}<p class="px-3 py-6 text-center text-xs text-muted-foreground" role="status">{types.length ? "Press Go or Enter to search or answer." : "Select at least one result type."}</p>
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
    <footer class="max-h-[48vh] shrink-0 overflow-y-auto border-t border-border px-3 py-2 text-xs text-muted-foreground">
      {#if navigationError}<p class="text-destructive" role="alert">{navigationError}</p>{/if}
      <div class="flex items-center justify-between gap-3">
        <span class="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
          {#if searching}<LoaderCircle aria-hidden="true" class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span>{intentBusy ? "Classifying with Jev…" : ragActive ? ragPhase === "retrieving" ? "Retrieving…" : "Generating…" : `Searching…${result.results.length ? ` · ${result.results.length} results` : ""}`}</span>
          {:else if ragPhase === "done"}<span>RAG · Answer complete</span>
          {:else if ragPhase === "stopped"}<span>RAG · Stopped</span>
          {:else if ragPhase === "error"}<span>RAG · Unavailable</span>
          {:else if view.submitted}<span>{result.results.length} results</span>{:else}<span>Enter to search</span>{/if}
        </span>
        {#if intentNotice}<span class="text-xs" role="status">{intentNotice}</span>{/if}
      </div>
      <details class="group/search-details mt-1">
        <summary class="flex w-fit list-none items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/search-details:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
          <span>Search details{notices.length || view.statusError || status?.error || status?.warning ? " · warnings" : ""}</span>
        </summary>
        <div class="space-y-2 pt-2">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Result types">
              {#each SEARCH_KINDS as kind}
                <button type="button" aria-pressed={types.includes(kind)} onclick={() => toggle(kind)}
                  data-search-kind={kind}
                  class="search-category-filter rounded border px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">{SEARCH_LABELS[kind]}</button>
              {/each}
            </div>
            <button type="button" onclick={onPreferences}
              class="shrink-0 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Search settings</button>
          </div>
          <div class="space-y-1">
          {#each notices as notice}<p>{notice}</p>{/each}
          {#if result.pendingSources?.length}<p>Waiting for {result.pendingSources.join(", ")}.</p>{/if}
          {#if intentNotice}<p>{intentNotice}</p>{/if}
          <p>Auto uses OpenRouter Jev Latest for intent classification on explicit submission only. Jev receives only the question, never source excerpts. Missing credentials or Jev failures fall back to Search.</p>
          <p>RAG reuses the selected project search sources, retrieves bounded source excerpts and sends the question and those excerpts to your configured RAG model provider. This may incur charges and share code, documentation and session excerpts with that provider. Results have navigable source references, but model-generated claims still require verification.</p>
          {#if types.includes("commits")}<p>Commits: BM25 + optional semantic search · all ancestors of current HEAD · changed file paths</p>
            <p>Use <code>patch:sessionWorker</code> to search changed Git lines on demand (literal text, read-only, limited to 50 matches / 8 seconds). Patch text is never indexed or sent to an embedding provider.</p>
            <p>The saved IDX provider may receive commit messages and queries. The first search may index the full HEAD history.</p>{/if}
          <p>{view.statusError ?? (status ? searchStatusLabel(status) : client ? 'Search status: loading…' : 'Session search: backend disconnected')}</p>
          {#if status?.error}<p>{status.error}</p>{/if}
          {#if status?.warning}<p>{status.warning}</p>{/if}
          {#if types.includes("sessions")}<p>Session excerpts: first user message and last completed assistant reply on the current branch. Indexed locally (FTS5), never sent to an embedding provider. Session names have a separate semantic opt-in.</p>{/if}
          <p>Local BM25 · {status?.enabled && status.keyAvailable ? 'semantic settings enabled' : 'semantic settings are opt-in'} · IDX hybrid uses the project provider and may refresh the index</p>
          {#if voiceSupported}<p>Voice input sends microphone audio to Deepgram. It fills the query; press Search or Enter to search.</p>{/if}
          </div>
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
