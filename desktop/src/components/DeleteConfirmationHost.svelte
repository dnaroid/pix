<script lang="ts">
  import { onMount } from "svelte";
  import { attachDeletionConfirmation, type DeletionRequest } from "../lib/confirm-deletion";
  import DeleteConfirmationDialog from "./DeleteConfirmationDialog.svelte";

  let request = $state<DeletionRequest | null>(null);
  onMount(() => attachDeletionConfirmation(next => { request = next; }));
</script>

{#if request}
  {#key request}
    {@const current = request}
    <DeleteConfirmationDialog
      title={current.title}
      message={current.message}
      okLabel={current.okLabel}
      onconfirm={() => current.finish(true)}
      oncancel={() => current.finish(false)}
    />
  {/key}
{/if}
