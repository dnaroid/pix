<script lang="ts">
  let {
    message,
    canReconnect,
    onReconnect,
    onDismiss,
  }: {
    message: string;
    canReconnect: boolean;
    onReconnect: () => void;
    onDismiss: () => void;
  } = $props();
</script>

<div class="row-start-1 mx-[22px] mt-2.5 flex items-center gap-2.5 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
  <span class="flex-1">{message}</span>
  {#if canReconnect}
    <button class="bg-transparent text-inherit hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onclick={onReconnect}>Reconnect</button>
  {/if}
  <button class="bg-transparent text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label="Dismiss error" onclick={onDismiss}>×</button>
</div>
