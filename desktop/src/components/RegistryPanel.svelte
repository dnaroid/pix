<script lang="ts">
  import {
    type RegistryActionRequest,
    type RegistryDiffIntent,
    type RegistryDiffState,
    type RegistryDiffTarget,
    type RegistryItem,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
    registryDiffAvailable,
    registryReviewTarget,
  } from "../lib/registry";
  import RegistryDiffPanel from "./RegistryDiffPanel.svelte";
  import RegistryProjectStatus from "./RegistryProjectStatus.svelte";
  import RegistryCatalog from "./RegistryCatalog.svelte";
  import type { RegistryBackgroundSyncState } from "../lib/registry-background-sync";
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import type { ModelThinkingModel } from "../lib/model-thinking";

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
    activity = null,
    diff,
    onRefresh,
    onInitializeProject,
    onCleanProject,
    onAction,
    onOpenProjectArtifact,
    onDiff,
    onCloseDiff,
    onConfirmReview,
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
    activity?: string | null;
    diff: RegistryDiffState | undefined;
    onRefresh: () => void;
    onInitializeProject: () => void;
    onCleanProject: () => void;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
    onOpenProjectArtifact: (artifact: RegistryProjectArtifact) => void;
    onDiff: (item: RegistryItem, intent?: RegistryDiffIntent) => void;
    onCloseDiff: () => void;
    onConfirmReview: (writeConflictMarkers?: boolean) => void;
  } = $props();

  let panelRoot = $state<HTMLElement | null>(null);
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

  function openItemDiff(item: RegistryItem, intent?: RegistryDiffIntent): void {
    // Remember the trigger so closing the diff can restore keyboard focus:
    // the catalog (and this button) unmounts while the diff view is open.
    // Review views (Merge / Mark as merged) return focus to the same card's Compare button.
    lastDiffTriggerId = item.id;
    onDiff(item, intent);
  }

  function retryDiff(target: RegistryDiffTarget): void {
    const item = (snapshot?.items ?? []).find((candidate) => target.intent
      ? registryReviewTarget(candidate, target.intent)?.name === target.name && candidate.type === target.type
      : candidate.type === target.type && candidate.name === target.name && registryDiffAvailable(candidate));
    if (item) openItemDiff(item, target.intent);
    else onCloseDiff();
  }
</script>

<section class="flex min-h-0 min-w-0 w-full flex-col overflow-hidden" aria-label="Resource registry" bind:this={panelRoot}>
  {#if activity}
    <p role="status" class="px-3 py-2 text-xs text-muted-foreground">{activity}</p>
  {/if}
  {#if diff}
    {@const diffState = diff}
    <RegistryDiffPanel
      diff={diffState}
      onClose={onCloseDiff}
      onRetry={() => retryDiff(diffState.target)}
      onConfirm={onConfirmReview}
      busy={remoteBusy}
    />
  {:else}
    <RegistryProjectStatus
      storageBusy={activity !== null}
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
      onReview={openItemDiff}
    />
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
