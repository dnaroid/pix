<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import X from "@lucide/svelte/icons/x";
  import type { SessionActivitySummary } from "../lib/session-activity";
  import type { SessionSubagentSnapshot } from "../lib/session-subagents";
  import type { SessionTodoSnapshot } from "../lib/session-todos";
  import SessionSubagentsPanel from "./SessionSubagentsPanel.svelte";
  import SessionTodosPanel from "./SessionTodosPanel.svelte";

  let {
    activeSessionId,
    sessionTitle,
    summary,
    todoSnapshot,
    subagentSnapshot,
    onClose,
  }: {
    activeSessionId: string | null;
    sessionTitle: string;
    summary: SessionActivitySummary;
    todoSnapshot: SessionTodoSnapshot | undefined;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
    onClose: () => void;
  } = $props();
</script>

<aside
  id="session-activity-inspector"
  class="relative z-20 grid min-h-0 w-80 shrink-0 grid-rows-[36px_minmax(0,1fr)] border-l border-border bg-panel text-foreground max-[980px]:absolute max-[980px]:inset-y-0 max-[980px]:right-0 max-[980px]:w-[min(320px,calc(100%_-_48px))] max-[980px]:shadow-md"
  aria-label="Session activity inspector"
>
  <header class="flex min-w-0 items-center gap-2 border-b border-border bg-chrome px-2.5">
    <Activity class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <strong class="shrink-0 text-[11px] font-semibold uppercase tracking-wide">Session</strong>
    <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={sessionTitle}>{sessionTitle}</span>
    <button
      class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      title="Close session activity"
      aria-label="Close session activity"
      onclick={onClose}
    ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </header>

  {#if !activeSessionId}
    <div class="grid min-h-0 place-items-center px-4 text-center">
      <div>
        <Activity class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium">No active session</p>
        <p class="mt-1 text-[11px] leading-4 text-muted-foreground">Open a conversation to inspect its runtime activity.</p>
      </div>
    </div>
  {:else}
    <div class="min-h-0 overflow-y-auto">
      <SessionSubagentsPanel snapshot={subagentSnapshot} activeCount={summary.activeSubagents} />
      <SessionTodosPanel snapshot={todoSnapshot} summary={summary} />
    </div>
  {/if}
</aside>

