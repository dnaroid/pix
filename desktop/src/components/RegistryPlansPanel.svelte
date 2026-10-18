<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import RegistryPlanRow from "./RegistryPlanRow.svelte";
  import type { PlanRun } from "../lib/project-task-plans";
  import { iconButtonClass } from "../lib/icon-button";
  import { projectDocumentLabel } from "../lib/project-documents";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import type { RegistryPlansView } from "./registry-plans-view.svelte";
  import type { PlanProgress } from "../lib/project-documents";
  import { onMount } from "svelte";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";

  let { plans, activePath, view, onChoose, planProgress = {}, onRefresh = async () => {}, actionsDisabled = false, runDisabled = false, onRun = () => {}, onDelete = () => {}, owners = {}, linkTargets = [], runs = {}, onLinkTask, onOpenRun, onResume }: {
    plans: readonly string[];
    activePath: string | null;
    view: RegistryPlansView;
    onChoose: (path: string) => void;
    planProgress?: Readonly<Record<string, PlanProgress | null>>;
    onRefresh?: () => Promise<void>;
    actionsDisabled?: boolean;
    runDisabled?: boolean;
    onRun?: (path: string) => void;
    onDelete?: (path: string) => void;
    /** Plan path -> owning task label. */
    owners?: Readonly<Record<string, string>>;
    /** Tasks that can still receive a plan. */
    linkTargets?: readonly { value: string; label: string }[];
    runs?: Readonly<Record<string, readonly PlanRun[]>>;
    onLinkTask?: (taskId: string, path: string) => void;
    onOpenRun?: (sessionId: string) => void;
    onResume?: (path: string) => void;
  } = $props();

  let searchInput = $state<HTMLInputElement>();
  const choices = $derived(view.visible(plans));
  const linked = $derived(choices.filter((plan) => owners[plan]));
  const unlinked = $derived(choices.filter((plan) => !owners[plan]));
  // Group headings only help once at least one plan belongs to a task.
  const groups = $derived(linked.length > 0
    ? [{ id: "linked", title: "Task plans", plans: linked }, { id: "unlinked", title: "Plans without a task", plans: unlinked }].filter((group) => group.plans.length > 0)
    : [{ id: "all", title: "", plans: unlinked }]);
  onMount(() => createProjectFilesRefresh(() => onRefresh(), undefined, 3_000).dispose);

  export function focusSearch(): void {
    searchInput?.focus({ preventScroll: true });
  }

  function focusPlan(event: KeyboardEvent): void {
    const root = (event.currentTarget as HTMLElement).closest("nav")!;
    const rows = [...root.querySelectorAll<HTMLButtonElement>("[data-plan-path]")];
    const current = rows.indexOf(event.target as HTMLButtonElement);
    const index = linearFocusIndex(current, event.key, rows.length, "vertical", false);
    if (index === null) return;
    event.preventDefault();
    rows[index]?.focus();
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Project plans">
  <div class="flex h-9 min-w-0 shrink-0 items-center gap-2 px-3">
    <FileText class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    <h3 class="shrink-0 text-xs font-semibold">Plans</h3>
    <div class="relative min-w-0 flex-1">
    <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    <input
      bind:this={searchInput}
      class="h-7 w-full rounded-md border border-input bg-background pr-8 pl-7 text-xs text-foreground placeholder:text-muted-foreground/70"
      type="search"
      aria-label="Find plan"
      placeholder="Find plan…"
      value={view.query}
      oninput={(event) => view.search(event.currentTarget.value)}
      onkeydown={(event) => {
        if (event.key === "Escape" && view.query) {
          event.preventDefault();
          event.stopPropagation();
          view.search("");
        }
      }}
      autocomplete="off"
      spellcheck="false"
    />
    {#if view.query}
      <button class={iconButtonClass("sm", "chrome", { extra: "absolute top-0.5 right-0.5" })} type="button" aria-label="Clear plan search" onclick={() => { view.search(""); focusSearch(); }}>
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    {/if}
    </div>
    <span class="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={`${plans.length} plans`}>{view.query.trim() ? `${choices.length} / ${plans.length}` : plans.length}</span>
  </div>
  <nav
    class="min-h-0 overflow-y-auto px-1.5 pb-1.5"
    aria-label="Plans"
    use:view.restoreList={{ workspace: view.workspace, query: view.query }}
  >
    {#if choices.length > 0}
      {#each groups as group (group.id)}
        {#if group.title}
          <h4 class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" data-plan-group={group.id}>{group.title}</h4>
        {/if}
        {#each group.plans as plan (plan)}
          <RegistryPlanRow
            {plan}
            label={projectDocumentLabel(plan)}
            active={activePath === plan}
            progress={planProgress[plan]}
            owner={owners[plan] ?? null}
            {linkTargets}
            runs={runs[plan] ?? []}
            {actionsDisabled}
            {runDisabled}
            {onChoose}
            onKeydown={focusPlan}
            {onRun}
            {onDelete}
            {onLinkTask}
            {onOpenRun}
            {onResume}
          />
        {/each}
      {/each}
    {:else}
      {#if plans.length === 0}
        <div class="px-4 py-8 text-center" data-plans-empty>
          <FileText class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p class="text-xs font-medium">No plans yet</p>
          <p class="mt-1 text-xs leading-4 text-muted-foreground">Ask the agent to write a plan; Markdown files in .pi/plans/ appear here.</p>
        </div>
      {:else}
        <p class="px-2 py-3 text-xs text-muted-foreground">No matching plans</p>
      {/if}
    {/if}
  </nav>
</section>
