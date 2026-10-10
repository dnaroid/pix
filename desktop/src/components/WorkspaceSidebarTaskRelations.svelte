<script lang="ts">
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Crown from "@lucide/svelte/icons/crown";
  import Link2 from "@lucide/svelte/icons/link-2";
  import FileText from "@lucide/svelte/icons/file-text";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import { normalizeProjectTaskLink, possibleTaskParents, projectTaskDisplayLabel, type ProjectTask } from "../lib/project-tasks";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import TaskProjectLinkInput from "./TaskProjectLinkInput.svelte";

  let {
    tasks,
    editingTaskId,
    parentId = $bindable(""),
    epic = $bindable(false),
    links = $bindable<string[]>([]),
    relatedTaskIds = $bindable<string[]>([]),
    projectFileSuggestions = [],
    onValidateProjectFile,
    onOpenTask,
    onOpenLink,
  }: {
    tasks: readonly ProjectTask[];
    editingTaskId: string | null;
    parentId: string;
    epic: boolean;
    links: string[];
    relatedTaskIds?: string[];
    projectFileSuggestions?: readonly string[];
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onOpenTask: (task: ProjectTask) => void;
    onOpenLink: (link: string) => void | Promise<void>;
  } = $props();

  let newLink = $state("");
  let linkError = $state("");
  let validating = $state(false);
  let relatedCandidate = $state("");
  const parents = $derived(possibleTaskParents(tasks, editingTaskId));
  const parentOptions = $derived([
    { value: "", label: "No parent (top-level)" },
    ...parents.map((candidate) => ({ value: candidate.id, label: projectTaskDisplayLabel(candidate) })),
  ]);
  const children = $derived(editingTaskId ? tasks.filter((task) => task.parentId === editingTaskId) : []);
  const selectedParent = $derived(tasks.find((task) => task.id === parentId));
  const linkedTasks = $derived(tasks.filter((task) => relatedTaskIds.includes(task.id)));
  const linkedFrom = $derived(editingTaskId ? tasks.filter((task) => task.relatedTaskIds?.includes(editingTaskId) && !relatedTaskIds.includes(task.id)) : []);
  const relatedCandidates = $derived(tasks.filter((task) => task.id !== editingTaskId && !relatedTaskIds.includes(task.id)));
  const relatedOptions = $derived([
    { value: "", label: "Choose a task…" },
    ...relatedCandidates.map((candidate) => ({ value: candidate.id, label: projectTaskDisplayLabel(candidate) })),
  ]);

  $effect(() => {
    editingTaskId;
    newLink = "";
    relatedCandidate = "";
    linkError = "";
  });

  async function addLink(): Promise<void> {
    if (validating) return;
    const owner = editingTaskId;
    const originalValue = newLink;
    const normalized = normalizeProjectTaskLink(newLink);
    if (!normalized) { linkError = "Use a project-relative path or an http(s) URL."; return; }
    if (links.length >= 50) { linkError = "A task supports at most 50 links."; return; }
    if (links.includes(normalized)) { linkError = "This link is already attached."; return; }
    if (!/^https?:\/\//i.test(normalized) && onValidateProjectFile) {
      validating = true;
      try {
        const exists = await onValidateProjectFile(normalized);
        if (owner !== editingTaskId || originalValue !== newLink) return;
        if (!exists) { linkError = "That file or artifact does not exist in this project."; return; }
      } catch (error) {
        if (owner === editingTaskId && originalValue === newLink) {
          linkError = error instanceof Error ? error.message : String(error);
        }
        return;
      } finally { validating = false; }
    }
    links = [...links, normalized];
    newLink = "";
    linkError = "";
  }
</script>

<section class="space-y-2 border-t border-sidebar-border pt-3" aria-label="Task relationships">
  <div class="flex items-center justify-between gap-2">
    <h3 class="text-xs font-semibold text-foreground">Hierarchy</h3>
    <label class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Mark as an epic">
      <input type="checkbox" class="accent-primary" checked={epic} onchange={(event) => { epic = event.currentTarget.checked; if (epic) parentId = ""; }} />
      <Crown class="h-3.5 w-3.5 text-tool-warning" aria-hidden="true" />Epic
    </label>
  </div>
  <div class="space-y-1">
    <span class="block text-xs text-muted-foreground">Parent task</span>
    <TaskFieldSelect value={parentId} options={parentOptions} ariaLabel="Parent task" searchable disabled={epic} onChange={(value) => parentId = value} />
  </div>
  {#if selectedParent}
    <button type="button" class="inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-primary hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" onclick={() => onOpenTask(selectedParent)} title="Open parent task"><GitBranch class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{projectTaskDisplayLabel(selectedParent)}</span></button>
  {/if}
  {#if editingTaskId}
    <div class="space-y-1" aria-label="Subtasks">
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><GitBranch class="h-3.5 w-3.5" aria-hidden="true" />Subtasks <span class="rounded-full bg-panel-strong px-1.5 font-mono text-xs">{children.length}</span></div>
      {#each children as child (child.id)}
        <button type="button" class="flex w-full min-w-0 items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 text-left text-xs hover:border-primary/40 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" onclick={() => onOpenTask(child)} title="Open subtask">
          <span class="min-w-0 flex-1 truncate">{projectTaskDisplayLabel(child)}</span>
          <span class="shrink-0 text-muted-foreground">{child.status}</span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<section class="space-y-2 border-t border-sidebar-border pt-3" aria-label="Related tasks">
  <h3 class="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Link2 class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />Related tasks <span class="ml-auto rounded-full bg-panel-strong px-1.5 font-mono text-xs font-normal text-muted-foreground">{linkedTasks.length + linkedFrom.length}</span></h3>
  {#each linkedTasks as related (related.id)}
    <div class="flex min-w-0 items-center gap-1 rounded-md border border-border/50 p-1">
      <button type="button" class="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" title="Open related task" onclick={() => onOpenTask(related)}>{projectTaskDisplayLabel(related)}</button>
      <button type="button" class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Unlink ${projectTaskDisplayLabel(related)}`} title="Unlink task" onclick={() => relatedTaskIds = relatedTaskIds.filter((id) => id !== related.id)}><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  {/each}
  {#each linkedFrom as related (related.id)}
    <button type="button" class="flex w-full min-w-0 items-center gap-2 rounded-md border border-border/50 p-2 text-left text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" title="Open task that linked here" onclick={() => onOpenTask(related)}><span class="min-w-0 flex-1 truncate">{projectTaskDisplayLabel(related)}</span><span class="shrink-0 text-xs">Linked from</span></button>
  {/each}
  <div class="flex gap-1">
    <div class="min-w-0 flex-1"><TaskFieldSelect value={relatedCandidate} options={relatedOptions} ariaLabel="Choose related task" searchable onChange={(value) => relatedCandidate = value} /></div>
    <button type="button" class="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" aria-label="Link related task" title="Link task" disabled={!relatedCandidate || relatedTaskIds.length >= 50} onclick={() => { if (relatedCandidate && !relatedTaskIds.includes(relatedCandidate)) relatedTaskIds = [...relatedTaskIds, relatedCandidate]; relatedCandidate = ""; }}><Plus class="h-4 w-4" aria-hidden="true" /></button>
  </div>
</section>

<section class="space-y-2 border-t border-sidebar-border pt-3" aria-label="Linked project files and artifacts">
  <h3 class="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Link2 class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />Related files &amp; artifacts <span class="ml-auto rounded-full bg-panel-strong px-1.5 font-mono text-xs font-normal text-muted-foreground">{links.length}</span></h3>
  {#each links as link (link)}
    <div class="flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-panel-strong/30 p-1">
      <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring" onclick={() => onOpenLink(link)} title={`Open ${link}`} aria-label={`Open linked file ${link}`}>
        {#if /^https?:\/\//i.test(link)}<ExternalLink class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{:else}<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
        <span class="min-w-0 truncate">{link}</span>
      </button>
      <button type="button" class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Remove link ${link}`} title="Remove link" onclick={() => links = links.filter((item) => item !== link)}><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  {/each}
  <TaskProjectLinkInput bind:value={newLink} suggestions={projectFileSuggestions} disabled={validating}
    onAdd={() => void addLink()} onInput={() => linkError = ""} />
  {#if linkError}<p class="text-xs text-tool-error" role="alert">{linkError}</p>{/if}
  <p class="text-xs leading-4 text-muted-foreground">Links stay project-relative; click to preview a file in the workbench.</p>
</section>
