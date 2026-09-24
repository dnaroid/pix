<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Download from "@lucide/svelte/icons/download";
  import Play from "@lucide/svelte/icons/play";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import Square from "@lucide/svelte/icons/square";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Wrench from "@lucide/svelte/icons/wrench";
  import { onMount } from "svelte";
  import {
    idxField,
    idxNumericField,
    idxOperationLabel,
    idxOperationStatusLabel,
    idxOutputSegments,
    type IdxOperationSnapshot,
    type IdxOverview,
    type IdxQueryKind,
  } from "../lib/idx";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import IdxOutput from "./IdxOutput.svelte";
  import TerminalView from "./TerminalView.svelte";
  import { createIdxPanelRuntimeController } from "./idx-panel-runtime-controller.svelte";
  import { createIdxPanelQueryController } from "./idx-panel-query-controller.svelte";
  import { createIdxPanelAuditController } from "./idx-panel-audit-controller.svelte";

  let {
    workspace,
    onValidateProjectFile,
    onOpenProjectFile,
    sessionReady,
    onRefreshKnowledge,
    onOverviewChange,
  }: {
    workspace: string;
    onValidateProjectFile: (path: string) => Promise<boolean>;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    sessionReady: boolean;
    onRefreshKnowledge: () => void;
    onOverviewChange?: (workspace: string, overview: IdxOverview | undefined) => void;
  } = $props();

  type PanelTab = "overview" | "knowledge" | "query";
  let activeTab = $state<PanelTab>("overview");
  const operationLinkValidation = new Map<string, Promise<boolean>>();
  $effect(() => {
    workspace;
    operationLinkValidation.clear();
  });

  const runtime = createIdxPanelRuntimeController({
    workspace: () => workspace,
    onOverviewChange: (requestWorkspace, nextOverview) => onOverviewChange?.(requestWorkspace, nextOverview),
  });
  const overview = $derived(runtime.overview);
  const loading = $derived(runtime.loading);
  const overviewRefreshRunning = $derived(runtime.overviewRefreshRunning);
  const installingIdx = $derived(runtime.installingIdx);
  const error = $derived(runtime.error);
  const runningOperation = $derived(runtime.runningOperation);
  const visibleOperation = $derived(runtime.visibleOperation);
  const indexReady = $derived(runtime.indexReady);

  const queryController = createIdxPanelQueryController({
    workspace: () => workspace,
    indexReady: () => runtime.indexReady,
    operationRunning: () => Boolean(runtime.runningOperation),
    setError: runtime.setError,
  });
  const queryState = queryController.state;
  const visibleQueryOutput = $derived(queryController.output);

  const auditController = createIdxPanelAuditController({
    workspace: () => workspace,
    indexReady: () => runtime.indexReady,
    operationRunning: () => Boolean(runtime.runningOperation),
    setError: runtime.setError,
  });
  const auditState = auditController.state;
  const auditOutput = $derived(auditController.output);

  const refresh = runtime.refresh;
  const installIdx = runtime.installIdx;
  const startOperation = runtime.startOperation;
  const stopOperation = runtime.stopOperation;
  const runQuery = queryController.runQuery;
  const runInspect = queryController.runInspect;
  const runAudit = auditController.run;

  onMount(() => runtime.start(() => queryState.queryRunning || queryState.inspectRunning || auditState.running));

  function numberValue(value: number | undefined): string {
    return value === undefined ? "—" : value.toLocaleString("en-US");
  }

  function operationTone(operation: IdxOperationSnapshot): string {
    if (operation.status === "running") return "text-tool-info";
    if (operation.status === "succeeded") return "text-tool-success";
    if (operation.status === "cancelled") return "text-tool-warning";
    return "text-tool-error";
  }

  function validateOperationLink(path: string): Promise<boolean> {
    const cached = operationLinkValidation.get(path);
    if (cached) return cached;
    const request = onValidateProjectFile(path).catch(() => false);
    operationLinkValidation.set(path, request);
    return request;
  }

  async function resolveOperationLinks(line: string) {
    const segments = idxOutputSegments(line);
    const links: Array<{
      startIndex: number;
      endIndex: number;
      text: string;
      activate: () => void | Promise<void>;
    }> = [];
    let offset = 0;

    for (const segment of segments) {
      const startIndex = offset;
      const endIndex = startIndex + segment.text.length;
      offset = endIndex;
      if (segment.kind !== "file" || !(await validateOperationLink(segment.path))) continue;
      links.push({
        startIndex,
        endIndex,
        text: segment.text,
        activate: () => onOpenProjectFile(segment.path, segment.range),
      });
    }
    return links;
  }

</script>

<section
  class={[
    "relative grid min-h-0 min-w-0 overflow-hidden bg-sidebar text-sidebar-foreground",
    visibleOperation && activeTab === "overview"
      ? "grid-rows-[auto_auto_auto_minmax(120px,1fr)]"
      : "grid-rows-[auto_auto_minmax(0,1fr)_auto]",
  ]}
  aria-label="IDX repository intelligence"
>
  <div class="flex h-9 min-w-0 items-center gap-2 border-b border-sidebar-border bg-panel px-2.5">
    <ScanSearch class="h-4 w-4 shrink-0 text-tool-search" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <strong class="truncate text-xs font-medium text-foreground">Repository index</strong>
        {#if overview?.version}<span class="shrink-0 font-mono text-xs text-muted-foreground">v{overview.version}</span>{/if}
      </div>
      <div class="truncate font-mono text-xs text-muted-foreground/70">{workspace || "No workspace"}</div>
    </div>
    <button
      class="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      type="button"
      title="Refresh IDX state"
      aria-label="Refresh IDX state"
      onclick={refresh}
      disabled={loading || overviewRefreshRunning || installingIdx}
    ><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
  </div>

  <div class="flex h-8 items-stretch border-b border-sidebar-border bg-chrome px-1.5" role="tablist" aria-label="IDX views">
    {#each [
      ["overview", "Overview"],
      ["knowledge", "Knowledge"],
      ["query", "Query"],
    ] as item}
      {@const tab = item[0] as PanelTab}
      <button
        class={[
          "h-8 cursor-pointer border-b-2 px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
          activeTab === tab ? "border-b-primary bg-panel text-foreground" : "border-b-transparent text-muted-foreground hover:bg-chrome-hover hover:text-foreground",
        ]}
        type="button"
        role="tab"
        aria-selected={activeTab === tab}
        onclick={() => activeTab = tab}
      >{item[1]}</button>
    {/each}
  </div>

  <div class="min-h-0 min-w-0 overflow-y-auto bg-sidebar">
    {#if loading && !overview}
      <div class="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Reading IDX state…</div>
    {:else if overview && !overview.available}
      <div class="px-4 py-10 text-center">
        <ScanSearch class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">IDX is not available</p>
        <p class="mx-auto mt-1 max-w-80 text-xs leading-4 text-muted-foreground">Install <span class="font-mono">indexer-cli</span> into Pix's private tools directory. Nothing is installed globally.</p>
        <button
          class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={installingIdx}
          onclick={() => void installIdx()}
        >
          {#if installingIdx}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<Download class="h-3.5 w-3.5" aria-hidden="true" />{/if}
          {installingIdx ? "Installing IDX…" : "Install IDX"}
        </button>
      </div>
    {:else if overview && !overview.initialized}
      <div class="px-4 py-10 text-center">
        <ScanSearch class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">Project is not indexed</p>
        <p class="mx-auto mt-1 max-w-80 text-xs leading-4 text-muted-foreground">Initialize project-local IDX storage before using code and knowledge search.</p>
        <button
          class="mt-3 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={Boolean(runningOperation)}
          onclick={() => void startOperation("init")}
        ><Play class="h-3 w-3" aria-hidden="true" />Initialize IDX</button>
      </div>
    {:else if activeTab === "overview"}
      <div class="divide-y divide-sidebar-border">
        <section class="bg-panel" aria-label="Code index status">
          <div class="flex h-8 items-center gap-2 px-2.5">
            <Activity class="h-3.5 w-3.5 text-tool-info" aria-hidden="true" />
            <h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Code index</h3>
            <span class="ml-auto font-mono text-xs text-muted-foreground">{overview?.indexStatus?.state ?? "unknown"}</span>
          </div>
          <dl class="grid grid-cols-4 border-y border-sidebar-border/70 bg-sidebar">
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Files</dt><dd class="mt-0.5 font-mono text-sm text-foreground">{numberValue(idxNumericField(overview?.indexStatus, "files"))}</dd></div>
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Symbols</dt><dd class="mt-0.5 font-mono text-sm text-foreground">{numberValue(idxNumericField(overview?.indexStatus, "symbols"))}</dd></div>
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Chunks</dt><dd class="mt-0.5 font-mono text-sm text-foreground">{numberValue(idxNumericField(overview?.indexStatus, "chunks"))}</dd></div>
            <div class="px-2 py-2"><dt class="text-xs text-muted-foreground">Deps</dt><dd class="mt-0.5 font-mono text-sm text-foreground">{numberValue(idxNumericField(overview?.indexStatus, "dependencies"))}</dd></div>
          </dl>
          <div class="space-y-1 px-2.5 py-2 font-mono text-xs leading-4 text-muted-foreground">
            {#if idxField(overview?.indexStatus, "gitRef")}<div><span class="text-muted-foreground/65">git</span> {idxField(overview?.indexStatus, "gitRef")}</div>{/if}
            {#if idxField(overview?.indexStatus, "languages")}<div class="break-words"><span class="text-muted-foreground/65">languages</span> {idxField(overview?.indexStatus, "languages")}</div>{/if}
          </div>
          <div class="flex flex-wrap gap-1 border-t border-sidebar-border/70 px-2 py-2">
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("index")}>Update index</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("full-index")}>Full reindex</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("dry-run")}>Dry run</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("doctor")}><span class="inline-flex items-center gap-1"><Wrench class="h-3 w-3" aria-hidden="true" />Doctor</span></button>
          </div>
        </section>


      </div>
    {:else if activeTab === "knowledge"}
      <section class="bg-panel" aria-label="Task-scoped knowledge audit">
        <div class="flex h-8 items-center gap-2 px-2.5">
          <h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Task-scoped audit</h3>
        </div>
        <div class="space-y-2 border-t border-sidebar-border/70 bg-sidebar p-2.5">
          <p class="text-xs leading-4 text-muted-foreground">Enter changed project-relative paths, one per line or comma-separated. Audit is read-only and only checks this task.</p>
          <label for="idx-audit-paths" class="block text-xs font-medium text-foreground">Changed paths</label>
          <textarea id="idx-audit-paths" class="h-24 w-full resize-none rounded-md border border-input bg-panel-strong p-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70" placeholder="src/feature.ts, specs/feature.md" value={auditState.pathsInput} oninput={(event) => auditController.setPathsInput(event.currentTarget.value)} spellcheck="false"></textarea>
          <div class="flex flex-wrap items-center gap-1.5">
            <button class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!indexReady || !auditController.pathsValid || auditState.running || Boolean(runningOperation)} onclick={() => void runAudit()}>{#if auditState.running}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Search class="h-3 w-3" aria-hidden="true" />{/if}Audit paths</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!sessionReady || Boolean(runningOperation)} onclick={onRefreshKnowledge}>Update in new session</button>
          </div>
        </div>
        {#if auditState.running && !auditOutput}
          <div class="border-t border-sidebar-border/70 px-3 py-3 text-xs text-muted-foreground">Auditing task paths…</div>
        {:else if auditOutput}
          <div class="max-h-96 overflow-auto border-t border-code-border bg-code px-2.5 py-2 text-xs leading-[1.55] text-foreground">
            {#key workspace}<IdxOutput text={auditOutput} className="text-xs leading-[1.55]" {onValidateProjectFile} {onOpenProjectFile} />{/key}
          </div>
          {#if auditController.activeResult?.truncated}<div class="px-2.5 py-1 text-xs text-tool-warning">output truncated</div>{/if}
        {/if}
      </section>
    {:else}
      <div class="grid min-h-full grid-rows-[auto_minmax(180px,1fr)]">
        <section class="border-b border-sidebar-border bg-panel p-2.5" aria-label="Semantic query">
          <div class="flex h-7 items-stretch border-b border-sidebar-border/70" role="tablist" aria-label="Query source">
            {#each [["code", "Code"], ["knowledge", "Documents"], ["context", "Context"]] as item}
              {@const kind = item[0] as IdxQueryKind}
              <button class={["cursor-pointer border-b-2 px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring", queryState.queryKind === kind ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground"]} type="button" role="tab" aria-selected={queryState.queryKind === kind} onclick={() => queryState.queryKind = kind}>{item[1]}</button>
            {/each}
          </div>
          <div class="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1">
            <input class="h-8 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70" aria-label="IDX semantic query" placeholder={queryState.queryKind === "context" ? "Describe the behavior or change…" : "Search repository…"} bind:value={queryState.queryText} onkeydown={(event) => { if (event.key === "Enter") void runQuery(); }} />
            <button class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!queryState.queryText.trim() || queryState.queryRunning || !indexReady || Boolean(runningOperation)} onclick={() => void runQuery()}>{#if queryState.queryRunning}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Search class="h-3 w-3" aria-hidden="true" />{/if}Run</button>
          </div>
          <div class="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
            <input class="h-7 min-w-40 basis-56 flex-1 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="IDX path prefix" placeholder="path prefix (optional)" bind:value={queryState.queryPathPrefix} spellcheck="false" />
            {#if queryState.queryKind === "code"}
              <label class="relative w-24 shrink-0"><span class="sr-only">Search mode</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={queryState.codeMode}><option value="hybrid">hybrid</option><option value="semantic">semantic</option><option value="lexical">lexical</option><option value="symbol">symbol</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <input class="h-7 w-14 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="50" aria-label="Maximum code results" bind:value={queryState.codeMaxFiles} />
              <label class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground"><input type="checkbox" bind:checked={queryState.codeIncludeContent} />content</label>
            {:else if queryState.queryKind === "knowledge"}
              <input class="h-7 w-14 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none" type="number" min="1" max="20" aria-label="Maximum document results" bind:value={queryState.knowledgeLimit} />
            {:else}
              <input class="h-7 w-20 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none" type="number" min="200" max="8000" aria-label="Context token budget" bind:value={queryState.contextBudget} />
            {/if}
          </div>
          {#if queryState.queryKind === "context"}
            <div class="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span>specs</span><input class="h-6 w-12 rounded-md border border-input bg-panel-strong px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="20" aria-label="Maximum context specs" bind:value={queryState.contextMaxSpecs} />
              <span>code</span><input class="h-6 w-12 rounded-md border border-input bg-panel-strong px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="30" aria-label="Maximum context code files" bind:value={queryState.contextMaxCode} />
              <span>tests</span><input class="h-6 w-12 rounded-md border border-input bg-panel-strong px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="20" aria-label="Maximum context tests" bind:value={queryState.contextMaxTests} />
            </div>
          {/if}
          <details class="mt-2 border-t border-sidebar-border/70 pt-1.5">
            <summary class="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Advanced index tools</summary>
            <div class="mt-1.5 grid grid-cols-[118px_minmax(0,1fr)_52px_52px_auto] gap-1">
              <label class="relative"><span class="sr-only">IDX inspect command</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-5 pl-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={queryState.inspectCommand}><option value="architecture">architecture</option><option value="structure">structure</option><option value="ast">ast</option><option value="explain">explain</option><option value="deps">deps</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <input class="h-7 min-w-0 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="IDX inspect target" placeholder={queryState.inspectCommand === "explain" ? "symbol" : queryState.inspectCommand === "ast" || queryState.inspectCommand === "deps" ? "path / module" : "target not required"} bind:value={queryState.inspectTarget} disabled={queryState.inspectCommand === "architecture" || queryState.inspectCommand === "structure"} spellcheck="false" />
              <input class="h-7 rounded-md border border-input bg-panel-strong px-1 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="8" aria-label="IDX inspect depth" bind:value={queryState.inspectDepth} />
              <input class="h-7 rounded-md border border-input bg-panel-strong px-1 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="300" aria-label="IDX inspect result limit" bind:value={queryState.inspectMaxFiles} />
              <button class="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-border bg-panel-strong text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" title="Run indexed inspection" aria-label="Run indexed inspection" disabled={queryState.inspectRunning || queryState.queryRunning || Boolean(runningOperation)} onclick={() => void runInspect()}>{#if queryState.inspectRunning}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Play class="h-3 w-3" aria-hidden="true" />{/if}</button>
            </div>
            <div class="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
              {#if queryState.inspectCommand === "explain"}<label class="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" bind:checked={queryState.inspectIncludeBody} />include body</label>{/if}
              {#if queryState.inspectCommand === "deps"}<label class="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" bind:checked={queryState.inspectShowEdges} />show edges</label><label class="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" bind:checked={queryState.inspectTests} />tests</label>{/if}
              <span class="font-mono text-muted-foreground/70">depth · limit</span>
            </div>
          </details>
        </section>
        <div class="relative min-h-0 bg-code">
          {#if (queryState.queryRunning || queryState.inspectRunning) && !visibleQueryOutput}
            <div class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{queryState.inspectRunning ? "Inspecting index…" : "Running semantic query…"}</div>
          {:else if visibleQueryOutput}
            <div class="h-full overflow-auto p-2.5 text-xs leading-[1.55] text-foreground">
              {#key workspace}<IdxOutput text={visibleQueryOutput} className="text-xs leading-[1.55]" {onValidateProjectFile} {onOpenProjectFile} />{/key}
            </div>
            {#if queryController.activeResult?.truncated}<div class="absolute right-2 bottom-2 rounded-md border border-border bg-popover px-1.5 py-0.5 text-xs text-tool-warning">output truncated</div>{/if}
          {:else}
            <div class="absolute inset-0 flex items-center justify-center px-4 text-center"><div class="max-w-72"><Search class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium text-foreground">Repository query</p><p class="mt-1 text-xs leading-4 text-muted-foreground">Search code or documents, or build a context pack.</p></div></div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if visibleOperation}
    <div class={[
      "grid min-h-0 grid-rows-[28px_minmax(0,1fr)] border-t border-code-border bg-code",
      activeTab === "overview" ? "h-full" : "",
    ]}>
      <div class="flex h-7 min-w-0 items-center gap-1.5 border-b border-code-border bg-chrome px-2">
        {#if visibleOperation.status === "running"}<RefreshCw class="h-3 w-3 animate-spin text-tool-info" aria-hidden="true" />{:else}<Activity class={`h-3 w-3 ${operationTone(visibleOperation)}`} aria-hidden="true" />{/if}
        <span class="truncate text-xs font-medium text-foreground">{idxOperationLabel(visibleOperation.kind)}</span>
        <span class="truncate font-mono text-xs text-muted-foreground">{visibleOperation.command}</span>
        <span class={`ml-auto shrink-0 font-mono text-xs ${operationTone(visibleOperation)}`}>{idxOperationStatusLabel(visibleOperation)}</span>
        {#if visibleOperation.status === "running"}
          <button class="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring" type="button" title="Stop IDX operation" aria-label="Stop IDX operation" onclick={() => void stopOperation(visibleOperation)}><Square class="h-3 w-3 fill-current" aria-hidden="true" /></button>
        {/if}
      </div>
      <div class={[
        "min-h-20 overflow-hidden bg-code p-1.5",
        activeTab === "overview" ? "h-full" : "h-32",
      ]}>
        {#key visibleOperation.id}
          <TerminalView
            content={visibleOperation.output || "Waiting for output…"}
            running={false}
            focusWhenRunning={false}
            convertEol
            ariaLabel={`${idxOperationLabel(visibleOperation.kind)} output`}
            resolveLinks={resolveOperationLinks}
          />
        {/key}
      </div>
    </div>
  {/if}

  {#if error || (overview?.errors.length ?? 0) > 0}
    <div class="absolute right-2 bottom-2 left-2 z-20 flex items-start gap-1.5 rounded-md border border-tool-error/30 bg-popover px-2 py-1.5 text-xs leading-4 text-tool-error shadow-md" role="status"><TriangleAlert class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{error ?? overview?.errors[0]}</span></div>
  {/if}
</section>
