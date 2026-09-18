<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import X from "@lucide/svelte/icons/x";
  import type { DesktopUpdater } from "../app/desktop-updater.svelte";

  let { updater }: { updater: DesktopUpdater } = $props();

  function mib(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
</script>

{#if updater.visible}
  <aside class="fixed right-3 top-[44px] z-50 w-[min(390px,calc(100vw-24px))] rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg" aria-live="polite">
    <div class="flex items-start gap-2.5">
      <div class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
        {#if updater.status === "ready"}<RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Download class="h-3.5 w-3.5" aria-hidden="true" />{/if}
      </div>
      <div class="min-w-0 flex-1">
        {#if updater.status === "available"}
          <div class="font-medium">Pix Desktop {updater.version} is available</div>
          <div class="mt-0.5 text-muted-foreground">Signed update from the latest GitHub Release.</div>
        {:else if updater.status === "downloading"}
          <div class="font-medium">Updating Pix Desktop…</div>
          <div class="mt-0.5 text-muted-foreground">
            {#if updater.totalBytes !== null}{mib(updater.downloadedBytes)} / {mib(updater.totalBytes)}{:else}{mib(updater.downloadedBytes)} downloaded{/if}
          </div>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div class="h-full bg-primary transition-[width]" style:width={updater.progress === null ? "12%" : `${Math.round(updater.progress * 100)}%`}></div>
          </div>
        {:else if updater.status === "ready"}
          <div class="font-medium">Pix Desktop {updater.version} is installed</div>
          <div class="mt-0.5 text-muted-foreground">Restart to run the new version.</div>
        {:else if updater.status === "error"}
          <div class="font-medium">Desktop update failed</div>
          <div class="mt-0.5 break-words text-muted-foreground">{updater.error ?? "Unknown updater error"}</div>
        {/if}

        <div class="mt-2.5 flex gap-2">
          {#if updater.status === "available"}
            <button class="rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onclick={() => void updater.install()}>Update</button>
          {:else if updater.status === "ready"}
            <button class="rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onclick={() => void updater.restart()}>Restart</button>
          {:else if updater.status === "error"}
            <button class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onclick={() => void updater.check()}><RefreshCw class="h-3 w-3" aria-hidden="true" /> Retry</button>
          {/if}
        </div>
      </div>
      {#if updater.status !== "downloading"}
        <button class="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label="Dismiss update notification" onclick={updater.dismiss}>
          <X class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      {/if}
    </div>
  </aside>
{/if}
