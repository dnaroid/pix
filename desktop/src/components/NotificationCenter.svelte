<script lang="ts">
  import Bell from "@lucide/svelte/icons/bell";
  import BellDot from "@lucide/svelte/icons/bell-dot";
  import { toasts as defaultStore, type ToastStore } from "../app/toasts.svelte";
  import StatusBarPopover from "./StatusBarPopover.svelte";
  import ToastLevelIcon from "./ToastLevelIcon.svelte";

  let { store = defaultStore }: { store?: ToastStore } = $props();

  const unread = $derived(store.unreadCount);
  const unreadLevel = $derived(store.unreadLevel);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Opening the center acknowledges everything it shows.
  function opened(): void {
    store.markAllRead();
  }
</script>

<StatusBarPopover label="Notifications" onOpen={opened}>
  {#snippet trigger({ open, toggle, id })}
    <button
      class={[
        "relative flex h-6 items-center gap-1 rounded-sm bg-transparent px-1.5 transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        open && "bg-chrome-hover",
        unreadLevel === "error" ? "text-tool-error" : unreadLevel === "warning" ? "text-tool-warning" : "",
      ]}
      type="button"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      data-notification-center-trigger
      onclick={toggle}
    >
      {#if unread}<BellDot class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Bell class="h-3.5 w-3.5" aria-hidden="true" />{/if}
      {#if unread}<span class="font-mono tabular-nums">{unread > 99 ? "99+" : unread}</span>{/if}
    </button>
  {/snippet}
  {#snippet children()}
    <div class="flex max-h-[min(480px,calc(100dvh-80px))] flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-md" data-notification-center>
      <div class="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
        <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Notifications</span>
        <div class="flex items-center gap-1">
          {#if store.active.length}
            <button type="button" class="rounded-sm px-1.5 py-0.5 text-xs text-foreground hover:bg-panel-hover" onclick={() => store.dismissAll()}>Hide toasts</button>
          {/if}
          <button type="button" class="rounded-sm px-1.5 py-0.5 text-xs text-foreground hover:bg-panel-hover disabled:opacity-40"
            disabled={!store.history.length} onclick={() => store.clearHistory()}>Clear</button>
        </div>
      </div>
      {#if store.history.length}
        <ul class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" aria-label="Notification history">
          {#each store.history as entry (entry.id)}
            <li class="flex items-start gap-2 px-2.5 py-1.5" data-notification-entry={entry.level}>
              <ToastLevelIcon level={entry.level} class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                  {#if entry.source}<span class="shrink-0 font-medium">{entry.source}</span>{/if}
                  <time class="shrink-0 tabular-nums" datetime={new Date(entry.createdAt).toISOString()}>{time.format(entry.createdAt)}</time>
                  {#if entry.count > 1}<span class="shrink-0 tabular-nums">×{entry.count}</span>{/if}
                </div>
                <p class="text-xs leading-4 break-words text-foreground">{entry.message}</p>
                {#if entry.detail}<p class="text-xs leading-4 break-words text-muted-foreground">{entry.detail}</p>{/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-2.5 py-4 text-center text-xs text-muted-foreground" role="status">No notifications in this session.</p>
      {/if}
    </div>
  {/snippet}
</StatusBarPopover>
