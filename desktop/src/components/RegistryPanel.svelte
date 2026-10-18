<script lang="ts">
  import {
    type RegistryActionRequest,
    type RegistryDiffState,
    type RegistryDiffTarget,
    type RegistryItem,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
    registryDiffAvailable,
  } from "../lib/registry";
  import RegistryDiffPanel from "./RegistryDiffPanel.svelte";
  import RegistryProjectStatus from "./RegistryProjectStatus.svelte";
  import RegistryCatalog from "./RegistryCatalog.svelte";
  import RegistryPlansPanel from "./RegistryPlansPanel.svelte";
  import type { RegistryPlansView } from "./registry-plans-view.svelte";
  import { tick } from "svelte";
  import type { RegistryBackgroundSyncState } from "../lib/registry-background-sync";
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import type { ModelThinkingModel } from "../lib/model-thinking";
  import type { PlanProgress } from "../lib/project-documents";

  let {
    snapshot,
    contextCommands = [],
    agentModels = [],
    backgroundSync,
    projectInitialized,
    projectPiSizeBytes,
    projectPiCleanupBytes,
    projectPiCleanupAvailable,
    projectPiStorageLoading,
    projectPiStorageError,
    loading,
    remoteDisabled,
    actionId,
    diff,
    onRefresh,
    onInitializeProject,
    onCleanProject,
    onAction,
    onOpenProjectArtifact,
    onDiff,
    onCloseDiff,
    plans = [],
    planProgress = {},
    onRefreshPlans = async () => {},
    activePlanPath = null,
    plansView,
    onChoosePlan = () => {},
    planActionsDisabled = false,
    planRunDisabled = false,
    onRunPlan = () => {},
    onDeletePlan = () => {},
  }: {
    snapshot: RegistrySnapshot | undefined;
    contextCommands?: readonly AvailableCommand[];
    agentModels?: readonly ModelThinkingModel[];
    backgroundSync: RegistryBackgroundSyncState;
    projectInitialized: boolean | undefined;
    projectPiSizeBytes: number | null | undefined;
    projectPiCleanupBytes: number | undefined;
    projectPiCleanupAvailable: boolean;
    projectPiStorageLoading: boolean;
    projectPiStorageError: string | null;
    loading: boolean;
    remoteDisabled: boolean;
    actionId: string | null;
    diff: RegistryDiffState | undefined;
    onRefresh: () => void;
    onInitializeProject: () => void;
    onCleanProject: () => void;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
    onOpenProjectArtifact: (artifact: RegistryProjectArtifact) => void;
    onDiff: (item: RegistryItem) => void;
    onCloseDiff: () => void;
    plans?: readonly string[];
    planProgress?: Readonly<Record<string, PlanProgress | null>>;
    onRefreshPlans?: () => Promise<void>;
    activePlanPath?: string | null;
    plansView?: RegistryPlansView;
    onChoosePlan?: (path: string) => void;
    planActionsDisabled?: boolean;
    planRunDisabled?: boolean;
    onRunPlan?: (path: string) => void;
    onDeletePlan?: (path: string) => void;
  } = $props();

  let panelRoot = $state<HTMLElement | null>(null);
  let plansPanel = $state<RegistryPlansPanel | null>(null);

  export async function focusPlans(): Promise<void> {
    if (diff) onCloseDiff();
    await tick();
    if (panelRoot?.isConnected) plansPanel?.focusSearch();
  }
  let lastDiffTriggerId = $state<string | null>(null);
  const remoteBusy = $derived(remoteDisabled || actionId !== null);

  $effect(() => {
    // Closing the diff remounts the catalog; send focus back to the Diff
    // button that opened it instead of dropping keyboard users on the body.
    if (diff === undefined && lastDiffTriggerId !== null) {
      const triggerId = lastDiffTriggerId;
      lastDiffTriggerId = null;
      panelRoot
        ?.querySelector<HTMLElement>(`[data-registry-diff-trigger="${CSS.escape(triggerId)}"]`)
        ?.focus();
    }
  });

  function openItemDiff(item: RegistryItem): void {
    // Remember the trigger so closing the diff can restore keyboard focus:
    // the catalog (and this button) unmounts while the diff view is open.
    lastDiffTriggerId = item.id;
    onDiff(item);
  }

  function retryDiff(target: RegistryDiffTarget): void {
    const item = (snapshot?.items ?? []).find(
      (candidate) => candidate.type === target.type && candidate.name === target.name && registryDiffAvailable(candidate),
    );
    if (item) openItemDiff(item);
    else onCloseDiff();
  }
</script>

<section class="flex min-h-0 min-w-0 w-full flex-col overflow-hidden" aria-label="Resource registry" bind:this={panelRoot}>
  {#if diff}
    {@const diffState = diff}
    <RegistryDiffPanel
      diff={diffState}
      onClose={onCloseDiff}
      onRetry={() => retryDiff(diffState.target)}
    />
  {:else}
    <RegistryProjectStatus
      {snapshot}
      {backgroundSync}
      {projectInitialized}
      {projectPiSizeBytes}
      {projectPiCleanupBytes}
      {projectPiCleanupAvailable}
      {projectPiStorageLoading}
      {projectPiStorageError}
      {actionId}
      {remoteBusy}
      {onInitializeProject}
      {onCleanProject}
      {onAction}
      {onOpenProjectArtifact}
    />
    {#if plansView}
      <RegistryPlansPanel bind:this={plansPanel} {plans} {planProgress} onRefresh={onRefreshPlans} activePath={activePlanPath} view={plansView} onChoose={onChoosePlan}
        actionsDisabled={planActionsDisabled} runDisabled={planRunDisabled} onRun={onRunPlan} onDelete={onDeletePlan} />
    {/if}
    <RegistryCatalog
      {snapshot}
      {contextCommands}
      {agentModels}
      {loading}
      {remoteDisabled}
      {actionId}
      {diff}
      {onAction}
      onDiff={openItemDiff}
    />
  {/if}
</section>
