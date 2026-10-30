<script lang="ts">
  import BookOpen from "@lucide/svelte/icons/book-open";
  import { onDestroy, untrack } from "svelte";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { emptyStateClass } from "../lib/status-text";
  import { createProjectWikiController } from "./project-wiki-controller.svelte";
  import ProjectWikiTree from "./ProjectWikiTree.svelte";
  import ProjectWikiSearch from "./ProjectWikiSearch.svelte";
  import ProjectWikiCheckQueue from "./ProjectWikiCheckQueue.svelte";
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";
  import type { ProjectFileLineRange } from "../lib/project-files";

  let { workspace, activePath = null, knowledgeJobs = [], onCancelKnowledgeCheck, onDismissKnowledgeCheck, onOpenKnowledgeCitation, onResolveKnowledgeJob, knowledgeSourcesEnabled = true, knowledgeResolving = false, onOpenFile, onOpenFiles, onOpenExternal, onBeforeMutation, ready = $bindable(false) }: {
    workspace: string;
    activePath?: string | null;
    knowledgeJobs?: readonly ProjectKnowledgeJob[];
    onCancelKnowledgeCheck?: (id: number) => void;
    onDismissKnowledgeCheck?: (id: number) => void;
    onOpenKnowledgeCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onResolveKnowledgeJob?: (job: ProjectKnowledgeJob) => void | Promise<void>;
    knowledgeSourcesEnabled?: boolean;
    knowledgeResolving?: boolean;
    onOpenFile: (path: string, searchRange?: ProjectFileLineRange) => void;
    onOpenFiles: (path: string) => void;
    onOpenExternal: (path: string) => void;
    onBeforeMutation?: () => Promise<() => void>;
    ready?: boolean;
  } = $props();
  const controller = createProjectWikiController({
    prepare: () => onBeforeMutation?.() ?? Promise.resolve(() => {}),
    report: (error, target) => createDiagnosticLogger(() => ({ workspace: target })).report(error, "wiki:load-failed"),
  });
  const wikiState = controller.state;
  type WikiTreeHandle = { cancelNavigation: () => void; create: (kind: "new-file" | "new-directory") => void; exportHtml: () => Promise<void>; showInFiles: () => void; refresh: () => void };
  let wikiTree = $state<WikiTreeHandle | null>(null);
  $effect(() => { ready = wikiTree !== null; });
  export function create(kind: "new-file" | "new-directory"): void { wikiTree?.create(kind); }
  export function exportHtml(): void { void wikiTree?.exportHtml(); }
  export function showInFiles(): void { wikiTree?.showInFiles(); }
  export function refresh(): void { wikiTree?.refresh(); }
  $effect(() => { const target = workspace; untrack(() => { void controller.selectWorkspace(target); }); });
  onDestroy(controller.dispose);

  function openFile(path: string, searchRange?: ProjectFileLineRange): void {
    wikiTree?.cancelNavigation();
    onOpenFile(path, searchRange);
  }
  function openCitation(citation: KnowledgeCitation, language?: KnowledgeReportLanguage): void | Promise<void> {
    wikiTree?.cancelNavigation();
    return onOpenKnowledgeCitation?.(citation, language);
  }
  function openFiles(path: string): void {
    wikiTree?.cancelNavigation();
    onOpenFiles(path);
  }

  async function initialize(): Promise<void> {
    const path = await controller.initialize();
    if (path) openFile(path);
  }
</script>

<svelte:window onfocus={() => { void controller.refresh(); }} />

{#if !workspace}
  <div class={emptyStateClass}><BookOpen class="mx-auto mb-2 h-5 w-5" aria-hidden="true" /><p>Open a project to write its Wiki.</p></div>
{:else if wikiState.loading && !wikiState.config}
  <p class={emptyStateClass} role="status">Loading Wiki…</p>
{:else}
  {#if wikiState.error}
    <div class="border-b border-border px-3 py-2 text-xs text-tool-error" role="alert">
      <p>{wikiState.error}</p>
      <button type="button" class="mt-2 rounded-sm px-2 py-1 text-foreground hover:bg-panel-hover" onclick={() => void controller.refresh()}>Retry</button>
    </div>
  {/if}
  {#if wikiState.config}
    {@const config = wikiState.config}
    {#if !wikiState.exists}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
        <BookOpen class="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <h2 class="text-sm font-semibold">A home for your project</h2>
        <p class="text-xs leading-5 text-muted-foreground">Organize requirements, rules and ideas into pages and sections. Markdown and images stay in <span class="font-mono">{config.path}/</span>.</p>
        <button type="button" class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40" disabled={wikiState.creating || wikiState.loading} onclick={() => void initialize()}>{wikiState.creating ? "Creating…" : "Create Wiki"}</button>
      </div>
    {:else}
      {#key `${workspace}\0${config.path}\0${config.index}`}
        <ProjectWikiSearch {workspace} path={config.path} {activePath} onOpenFile={openFile}>
          {#if !wikiState.indexExists}
            <div class="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3">
              <span class="min-w-0 flex-1 text-xs text-muted-foreground">Automatic contents</span>
              <button type="button" class="rounded-sm px-2 py-1 text-xs hover:bg-panel-hover disabled:opacity-40" disabled={wikiState.creating || wikiState.loading} onclick={() => void initialize()}>{wikiState.creating ? "Creating…" : "Create index"}</button>
            </div>
          {/if}
          <ProjectWikiTree bind:this={wikiTree} {workspace} {config} {activePath} onOpenFile={openFile} onOpenFiles={openFiles} {onOpenExternal} {onBeforeMutation} onRefreshConfig={() => void controller.refresh()} />
        </ProjectWikiSearch>
      {/key}
    {/if}
  {:else if !wikiState.error}
    <div class={emptyStateClass}>Wiki is unavailable.</div>
  {/if}
{/if}

{#if workspace}
  <ProjectWikiCheckQueue {workspace} jobs={knowledgeJobs} onCancel={onCancelKnowledgeCheck} onDismiss={onDismissKnowledgeCheck} onOpenFile={openFile}
    canOpenSources={knowledgeSourcesEnabled} onOpenCitation={onOpenKnowledgeCitation ? openCitation : undefined}
    onResolve={onResolveKnowledgeJob} resolving={knowledgeResolving} />
{/if}
