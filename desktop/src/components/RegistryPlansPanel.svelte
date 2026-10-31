<script lang="ts">
  import RegistryPlanRow from "./RegistryPlanRow.svelte";
  import type { PlanRun } from "../lib/project-task-plans";
  import { projectDocumentLabel } from "../lib/project-documents";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import type { RegistryPlansView } from "./registry-plans-view.svelte";
  import type { PlanProgress } from "../lib/project-documents";
  import { onMount } from "svelte";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";

  let { plans, activePath, view, onChoose, planProgress = {}, onRefresh = async () => {}, actionsDisabled = false, runDisabled = false, onRun = () => {}, onDelete = () => {}, owners = {}, runs = {}, onOpenRun, onResume }: {
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
    runs?: Readonly<Record<string, readonly PlanRun[]>>;
    onOpenRun?: (sessionId: string) => void;
    onResume?: (path: string) => void;
  } = $props();

  const diagnostics = createDiagnosticLogger(() => ({ workspace: view.workspace }));
  onMount(() => createProjectFilesRefresh(() => onRefresh(), undefined, 3_000,
    (error) => diagnostics.warn("registry:plans-refresh", error)).dispose);

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
  <nav
    class="flex min-h-0 flex-col gap-1 overflow-y-auto p-1.5"
    aria-label="Plans"
    use:view.restoreList={{ workspace: view.workspace }}
  >
    {#each plans as plan (plan)}
      <RegistryPlanRow
        {plan}
        label={projectDocumentLabel(plan)}
        active={activePath === plan}
        progress={planProgress[plan]}
        owner={owners[plan] ?? null}
        runs={runs[plan] ?? []}
        {actionsDisabled}
        {runDisabled}
        {onChoose}
        onKeydown={focusPlan}
        {onRun}
        {onDelete}
        {onOpenRun}
        {onResume}
      />
    {:else}
      <p class="px-2 py-3 text-xs text-muted-foreground" data-plans-empty>No plans yet. Markdown files in .pi/plans/ appear here.</p>
    {/each}
  </nav>
</section>
