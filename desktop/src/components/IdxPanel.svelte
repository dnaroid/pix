<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import BookOpenCheck from "@lucide/svelte/icons/book-open-check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import FileText from "@lucide/svelte/icons/file-text";
  import Link2 from "@lucide/svelte/icons/link-2";
  import Play from "@lucide/svelte/icons/play";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Square from "@lucide/svelte/icons/square";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Wrench from "@lucide/svelte/icons/wrench";
  import { onMount } from "svelte";
  import {
    idxArchivedPrimaryCount,
    idxCurrentPrimaryCount,
    idxField,
    idxKnowledgeCandidates,
    idxKnowledgeIssues,
    idxKnowledgeNeedsAttention,
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
  import {
    createIdxPanelKnowledgeController,
    delimitedItems,
  } from "./idx-panel-knowledge-controller.svelte";

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

  const runtime = createIdxPanelRuntimeController({
    workspace: () => workspace,
    onOverviewChange: (requestWorkspace, nextOverview) => onOverviewChange?.(requestWorkspace, nextOverview),
  });
  const overview = $derived(runtime.overview);
  const loading = $derived(runtime.loading);
  const overviewRefreshRunning = $derived(runtime.overviewRefreshRunning);
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

  const knowledgeController = createIdxPanelKnowledgeController({
    workspace: () => workspace,
    indexReady: () => runtime.indexReady,
    operationRunning: () => Boolean(runtime.runningOperation),
    refreshOverview: runtime.refreshOverview,
    setError: runtime.setError,
    onOpenProjectFile: (path) => onOpenProjectFile(path),
  });
  const knowledgeState = knowledgeController.state;
  const knowledgeOutput = $derived(knowledgeController.output);

  const knowledgeIssues = $derived(idxKnowledgeIssues(overview?.wikiStatus));
  const latestDiscover = $derived([...runtime.operations].reverse().find((operation) => operation.kind === "wiki-discover"));
  const discoverCandidates = $derived(idxKnowledgeCandidates(latestDiscover?.output ?? ""));
  const currentPrimaryCount = $derived(idxCurrentPrimaryCount(overview?.wikiStatus));
  const archivedPrimaryCount = $derived(idxArchivedPrimaryCount(overview?.wikiStatus));
  const knowledgeNeedsAttention = $derived(idxKnowledgeNeedsAttention(overview?.wikiStatus));

  const refresh = runtime.refresh;
  const startOperation = runtime.startOperation;
  const stopOperation = runtime.stopOperation;
  const runQuery = queryController.runQuery;
  const runInspect = queryController.runInspect;
  const selectKnowledgePath = knowledgeController.selectPath;
  const runKnowledgeAction = knowledgeController.run;

  onMount(() => runtime.start(() => queryState.queryRunning || queryState.inspectRunning));

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
      disabled={loading || overviewRefreshRunning}
    ><RefreshCw class={["h-3.5 w-3.5", loading || overviewRefreshRunning ? "animate-spin" : ""]} aria-hidden="true" /></button>
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
        <p class="mx-auto mt-1 max-w-80 text-xs leading-4 text-muted-foreground">Install indexer-cli or expose <span class="font-mono">idx</span> in your login-shell PATH, then refresh.</p>
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

        <section class="bg-panel" aria-label="Knowledge base status">
          <div class="flex h-8 items-center gap-2 px-2.5">
            <BookOpenCheck class="h-3.5 w-3.5 text-tool-search" aria-hidden="true" />
            <h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Knowledge base</h3>
            {#if knowledgeNeedsAttention}<span class="ml-auto text-xs text-tool-warning">update needed</span>{/if}
          </div>
          <dl class="grid grid-cols-4 border-y border-sidebar-border/70 bg-sidebar">
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Current</dt><dd class="mt-0.5 font-mono text-sm text-foreground">{numberValue(currentPrimaryCount)}</dd></div>
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Fresh</dt><dd class={["mt-0.5 font-mono text-sm", knowledgeNeedsAttention ? "text-tool-warning" : "text-tool-success"]}>{numberValue(idxNumericField(overview?.wikiStatus, "fresh"))}</dd></div>
            <div class="border-r border-sidebar-border/70 px-2 py-2"><dt class="text-xs text-muted-foreground">Review</dt><dd class="mt-0.5 font-mono text-sm text-tool-warning">{numberValue(idxNumericField(overview?.wikiStatus, "needsReview"))}</dd></div>
            <div class="px-2 py-2"><dt class="text-xs text-muted-foreground">Unresolved refs</dt><dd class="mt-0.5 font-mono text-sm text-muted-foreground">{numberValue(idxNumericField(overview?.wikiStatus, "unresolvedRefs"))}</dd></div>
          </dl>
          <div class="flex flex-wrap gap-x-3 gap-y-1 border-b border-sidebar-border/70 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
            <span>archived <span class="text-foreground">{numberValue(archivedPrimaryCount)}</span></span>
            <span>unverified <span class="text-foreground">{numberValue(idxNumericField(overview?.wikiStatus, "unverified"))}</span></span>
            <span>candidates <span class="text-foreground">{numberValue(idxNumericField(overview?.wikiStatus, "newChangedCandidates"))}</span></span>
            <span>uncovered <span class="text-foreground">{numberValue(idxNumericField(overview?.wikiStatus, "uncoveredActiveAsIs"))}</span></span>
          </div>
          <div class="flex flex-wrap gap-1 px-2 py-2">
            <button
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 text-xs font-medium text-foreground hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
              type="button"
              title="Start a new session that reviews and updates the project knowledge base"
              disabled={!sessionReady || Boolean(runningOperation)}
              onclick={onRefreshKnowledge}
            ><Play class="h-3 w-3" aria-hidden="true" />Update in new session</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("wiki-audit")}>Audit</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("wiki-discover")}>Discover</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={Boolean(runningOperation)} onclick={() => void startOperation("wiki-catalog")}>Catalog</button>
            <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("impact")}>Impact</button>
          </div>
        </section>
      </div>
    {:else if activeTab === "knowledge"}
      <div class="divide-y divide-sidebar-border">
        <section class="bg-panel" aria-label="Knowledge health">
          <div class="flex h-8 items-center gap-2 px-2.5"><TriangleAlert class="h-3.5 w-3.5 text-tool-warning" aria-hidden="true" /><h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Needs attention</h3><span class="ml-auto font-mono text-xs text-muted-foreground">{knowledgeIssues.length}</span></div>
          {#if knowledgeIssues.length === 0}
            <div class="border-t border-sidebar-border/70 px-3 py-5 text-center text-xs text-muted-foreground">No stale primary knowledge reported.</div>
          {:else}
            <div class="divide-y divide-sidebar-border/70 border-t border-sidebar-border/70 bg-sidebar">
              {#each knowledgeIssues as issue (`${issue.status}:${issue.path}`)}
                <div class={[
                  "group flex min-w-0 items-start gap-2 px-2.5 py-1.5 hover:bg-panel-hover",
                  knowledgeState.path === issue.path && "bg-panel-selected",
                ]}>
                  <button class="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={() => selectKnowledgePath(issue.path)}>
                    <div class="flex min-w-0 items-center gap-1.5"><span class="shrink-0 font-mono text-xs text-tool-warning">{issue.status}</span><span class="truncate font-mono text-xs text-foreground">{issue.path}</span></div>
                    <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={issue.detail}>{issue.detail}</div>
                  </button>
                  <button class="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100" type="button" title="Open source" aria-label={`Open ${issue.path}`} onclick={() => selectKnowledgePath(issue.path, true)}><FileText class="h-3 w-3" aria-hidden="true" /></button>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        {#if discoverCandidates.length > 0}
          <section class="bg-panel" aria-label="Knowledge candidates">
            <div class="flex h-8 items-center gap-2 px-2.5"><Search class="h-3.5 w-3.5 text-tool-search" aria-hidden="true" /><h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Discovered candidates</h3><span class="ml-auto font-mono text-xs text-muted-foreground">{discoverCandidates.length}</span></div>
            <div class="divide-y divide-sidebar-border/70 border-t border-sidebar-border/70 bg-sidebar">
              {#each discoverCandidates as candidate (candidate.path)}
                <button class="block w-full cursor-pointer px-2.5 py-1.5 text-left hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" type="button" onclick={() => selectKnowledgePath(candidate.path, true)}>
                  <div class="flex min-w-0 gap-1.5"><span class="font-mono text-xs text-tool-search">{candidate.score ?? "—"}</span><span class="truncate font-mono text-xs text-foreground">{candidate.path}</span>{#if candidate.known}<span class="ml-auto shrink-0 text-xs text-muted-foreground">{candidate.known}</span>{/if}</div>
                  {#if candidate.title}<div class="mt-0.5 truncate text-xs text-muted-foreground">{candidate.title}</div>{/if}
                </button>
              {/each}
            </div>
          </section>
        {/if}

        <section class="bg-panel" aria-label="Knowledge maintenance">
          <div class="flex h-8 items-center gap-2 px-2.5"><ShieldCheck class="h-3.5 w-3.5 text-tool-info" aria-hidden="true" /><h3 class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Maintenance</h3></div>
          <div class="space-y-2 border-t border-sidebar-border/70 bg-sidebar p-2.5">
            <div class="flex gap-1">
              <input class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Knowledge source path" placeholder="specs/behavior.md" bind:value={knowledgeState.path} spellcheck="false" />
              <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!knowledgeState.path.trim()} onclick={() => void onOpenProjectFile(knowledgeState.path.trim())}>Open</button>
              <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!knowledgeState.path.trim() || knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("show")}>Show</button>
            </div>

            <div class="grid grid-cols-2 gap-1.5">
              <label class="relative"><span class="sr-only">Classification</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.classification}><option value="spec">spec</option><option value="spec-like">spec-like</option><option value="meta-index">meta-index</option><option value="design-only">design-only</option><option value="guide">guide</option><option value="other">other</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <label class="relative"><span class="sr-only">Confidence</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.confidence}><option value="high">high confidence</option><option value="medium">medium confidence</option><option value="low">low confidence</option><option value="unknown">unknown confidence</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <label class="relative"><span class="sr-only">Behavior type</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.behaviorType}><option value="as-is">as-is</option><option value="change">change</option><option value="mixed">mixed</option><option value="unknown">unknown type</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <label class="relative"><span class="sr-only">Lifecycle</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.lifecycle}><option value="active">active</option><option value="proposed">proposed</option><option value="historical">historical</option><option value="superseded">superseded</option><option value="unknown">unknown lifecycle</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
            </div>
            <input class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Knowledge summary" placeholder="Reviewed retrieval summary…" bind:value={knowledgeState.summary} />
            <input class="h-7 w-full rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Knowledge topics" placeholder="topics, comma separated" bind:value={knowledgeState.topics} />
            <div class="flex flex-wrap items-center gap-2 border-t border-sidebar-border/70 pt-2">
              <label class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" bind:checked={knowledgeState.sourceReviewed} />Source reviewed</label>
              <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!knowledgeState.sourceReviewed || !knowledgeState.path.trim() || knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("record")}>Record</button>
              <label class="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" bind:checked={knowledgeState.evidenceReviewed} />Evidence reviewed</label>
              <button class="h-7 cursor-pointer rounded-md border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!knowledgeState.evidenceReviewed || !knowledgeState.path.trim() || knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("verify")}>Verify</button>
            </div>

            <div class="grid grid-cols-[minmax(0,1fr)_100px_80px_auto] gap-1 border-t border-sidebar-border/70 pt-2">
              <input class="h-7 min-w-0 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Relation target paths" placeholder="src/file.ts" bind:value={knowledgeState.relationTargets} />
              <label class="relative"><span class="sr-only">Relation kind</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-5 pl-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.relationKind}><option value="implements">implements</option><option value="tests">tests</option><option value="related">related</option><option value="supersedes">supersedes</option><option value="superseded-by">superseded-by</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <label class="relative"><span class="sr-only">Relation action</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-5 pl-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={knowledgeState.relationAction}><option value="add">add</option><option value="remove">remove</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <button class="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-border bg-panel-strong text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" title="Apply relation" aria-label="Apply knowledge relation" disabled={!knowledgeState.evidenceReviewed || !knowledgeState.path.trim() || delimitedItems(knowledgeState.relationTargets).length === 0 || knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("relate")}><Link2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
            <div class="flex justify-end">
              <button class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-tool-error/10 hover:text-tool-error focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!knowledgeState.path.trim() || knowledgeState.action !== null || Boolean(runningOperation)} onclick={() => void runKnowledgeAction("remove")}><Trash2 class="h-3 w-3" aria-hidden="true" />Remove metadata</button>
            </div>
          </div>
          {#if knowledgeOutput}
            <div class="max-h-52 overflow-auto border-t border-code-border bg-code px-2.5 py-2 text-xs leading-[1.55] text-foreground">
              <IdxOutput text={knowledgeOutput} className="text-xs leading-[1.55]" {onValidateProjectFile} {onOpenProjectFile} />
            </div>
          {/if}
        </section>
      </div>
    {:else}
      <div class="grid min-h-full grid-rows-[auto_minmax(180px,1fr)]">
        <section class="border-b border-sidebar-border bg-panel p-2.5" aria-label="Semantic query">
          <div class="flex h-7 items-stretch border-b border-sidebar-border/70" role="tablist" aria-label="Query source">
            {#each [["code", "Code"], ["knowledge", "Knowledge"], ["context", "Context"]] as item}
              {@const kind = item[0] as IdxQueryKind}
              <button class={["cursor-pointer border-b-2 px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring", queryState.queryKind === kind ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground hover:text-foreground"]} type="button" role="tab" aria-selected={queryState.queryKind === kind} onclick={() => queryState.queryKind = kind}>{item[1]}</button>
            {/each}
          </div>
          <div class="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1">
            <input class="h-8 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="IDX semantic query" placeholder={queryState.queryKind === "context" ? "Describe the behavior or change…" : "Search repository…"} bind:value={queryState.queryText} onkeydown={(event) => { if (event.key === "Enter") void runQuery(); }} />
            <button class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" type="button" disabled={!queryState.queryText.trim() || queryState.queryRunning || !indexReady || Boolean(runningOperation)} onclick={() => void runQuery()}>{#if queryState.queryRunning}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}<Search class="h-3 w-3" aria-hidden="true" />{/if}Run</button>
          </div>
          <div class="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
            <input class="h-7 min-w-40 basis-56 flex-1 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="IDX path prefix" placeholder="path prefix (optional)" bind:value={queryState.queryPathPrefix} spellcheck="false" />
            {#if queryState.queryKind === "code"}
              <label class="relative w-24 shrink-0"><span class="sr-only">Search mode</span><select class="h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-panel-strong pr-6 pl-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" bind:value={queryState.codeMode}><option value="hybrid">hybrid</option><option value="semantic">semantic</option><option value="lexical">lexical</option><option value="symbol">symbol</option></select><ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></label>
              <input class="h-7 w-14 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="50" aria-label="Maximum code results" bind:value={queryState.codeMaxFiles} />
              <label class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground"><input type="checkbox" bind:checked={queryState.codeIncludeContent} />content</label>
            {:else if queryState.queryKind === "knowledge"}
              <input class="h-7 w-14 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="1" max="20" aria-label="Maximum knowledge results" bind:value={queryState.knowledgeLimit} />
              <label class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground"><input type="checkbox" bind:checked={queryState.includeSecondary} />secondary</label>
            {:else}
              <input class="h-7 w-20 shrink-0 rounded-md border border-input bg-panel-strong px-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" type="number" min="200" max="8000" aria-label="Context token budget" bind:value={queryState.contextBudget} />
              <label class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground"><input type="checkbox" bind:checked={queryState.includeSecondary} />secondary</label>
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
              <IdxOutput text={visibleQueryOutput} className="text-xs leading-[1.55]" {onValidateProjectFile} {onOpenProjectFile} />
            </div>
            {#if queryController.activeResult?.truncated}<div class="absolute right-2 bottom-2 rounded-md border border-border bg-popover px-1.5 py-0.5 text-xs text-tool-warning">output truncated</div>{/if}
          {:else}
            <div class="absolute inset-0 flex items-center justify-center px-4 text-center"><div class="max-w-72"><Search class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" /><p class="text-xs font-medium text-foreground">Semantic repository query</p><p class="mt-1 text-xs leading-4 text-muted-foreground">Search indexed code, primary knowledge, or build a combined context pack.</p></div></div>
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
