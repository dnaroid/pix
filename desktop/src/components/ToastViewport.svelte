<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { toasts as defaultStore, type ToastStore } from "../app/toasts.svelte";
  import ToastLevelIcon from "./ToastLevelIcon.svelte";

  let { store = defaultStore, maxVisible = 3 }: { store?: ToastStore; maxVisible?: number } = $props();

  const visible = $derived(store.active.slice(-maxVisible));
  const hiddenCount = $derived(Math.max(0, store.active.length - visible.length));

  function focusout(event: FocusEvent): void {
    const container = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) store.resume();
  }
</script>

<!-- Bottom-right stack above the status bar; empty space never blocks the workbench. -->
{#if store.active.length}
  <section
    class="pointer-events-none fixed right-3 bottom-9 z-50 flex w-[360px] max-w-[calc(100vw-24px)] flex-col items-stretch gap-2"
    aria-label="Notifications"
    data-toast-viewport
  >
    {#if hiddenCount > 0}
      <div class="pointer-events-auto flex items-center justify-between gap-2 self-end rounded-md border border-border bg-popover/95 px-2 py-1 text-xs text-muted-foreground shadow-sm">
        <span>+{hiddenCount} more</span>
        <button type="button" class="rounded-sm px-1 text-foreground hover:bg-panel-hover" onclick={() => store.dismissAll()}>Dismiss all</button>
      </div>
    {/if}
    {#each visible as toast (toast.id)}
      <div
        class={[
          "pointer-events-auto flex items-start gap-2.5 rounded-md border bg-popover p-2.5 text-popover-foreground shadow-md",
          toast.level === "error" ? "border-tool-error/40" : toast.level === "warning" ? "border-tool-warning/40" : "border-border",
        ]}
        role={toast.level === "error" ? "alert" : "status"}
        aria-live={toast.level === "error" ? "assertive" : "polite"}
        data-toast={toast.level}
        tabindex="-1"
        onpointerenter={() => store.pause()}
        onpointerleave={() => store.resume()}
        onfocusin={() => store.pause()}
        onfocusout={focusout}
      >
        <ToastLevelIcon level={toast.level} class="mt-0.5 h-4 w-4 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-baseline gap-1.5">
            {#if toast.source}<span class="shrink-0 text-xs font-medium text-muted-foreground">{toast.source}</span>{/if}
            {#if toast.count > 1}<span class="shrink-0 rounded-sm bg-panel-strong px-1 text-xs tabular-nums text-muted-foreground" aria-label={`Repeated ${toast.count} times`}>×{toast.count}</span>{/if}
          </div>
          <p class="text-xs leading-4 break-words text-foreground">{toast.message}</p>
          {#if toast.detail}<p class="mt-0.5 text-xs leading-4 break-words text-muted-foreground">{toast.detail}</p>{/if}
          {#if toast.actions.length}
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              {#each toast.actions as action (action.label)}
                <button type="button" class="h-6 rounded-sm border border-border bg-panel-strong px-2 text-xs text-foreground hover:bg-panel-hover"
                  onclick={() => store.runAction(toast.id, action)}>{action.label}</button>
              {/each}
            </div>
          {/if}
        </div>
        <button type="button" class="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground"
          aria-label="Dismiss notification" onclick={() => store.dismiss(toast.id)}>
          <X class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    {/each}
  </section>
{/if}
