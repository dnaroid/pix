<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import type { SessionSubagentSnapshot } from "../lib/session-subagents";
  import type { SessionTodoSnapshot } from "../lib/session-todos";
  import SessionSubagentsPanel from "./SessionSubagentsPanel.svelte";
  import SessionTodosPanel from "./SessionTodosPanel.svelte";

  let {
    activeSessionId,
    todoSnapshot,
    subagentSnapshot,
  }: {
    activeSessionId: string | null;
    todoSnapshot: SessionTodoSnapshot | undefined;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
  } = $props();
</script>

<section class="min-h-0 overflow-y-auto" aria-label="Current session activity">
  {#if !activeSessionId}
    <div class="px-4 py-8 text-center">
      <Activity class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p class="text-xs font-medium">No active session</p>
      <p class="mt-1 text-[10px] leading-4 text-muted-foreground">Open a session to see its runtime activity.</p>
    </div>
  {:else}
    <SessionSubagentsPanel snapshot={subagentSnapshot} />
    <SessionTodosPanel snapshot={todoSnapshot} />
  {/if}
</section>
