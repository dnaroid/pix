<script lang="ts">
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import type { AgentControlState } from "../lib/agent-control";
  import type { ComposerActivity as Activity } from "../lib/composer-activity";
  import ComposerActivity from "./ComposerActivity.svelte";

  let {
    activity,
    promptRunning,
    agentControlState,
    showControls = true,
    onPause,
    onCancel,
    onContinue,
  }: {
    activity?: Activity;
    promptRunning: boolean;
    agentControlState: AgentControlState;
    showControls?: boolean;
    onPause: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
    onContinue: () => void | Promise<void>;
  } = $props();

  const canContinue = $derived(agentControlState === "paused" || agentControlState === "continuable");
  const hasControls = $derived(showControls && (promptRunning || canContinue));
</script>

{#if activity || hasControls}
  <div data-composer-activity-row class="mb-1.5 flex min-h-7 min-w-0 items-center gap-2 pr-[9px] text-xs text-muted-foreground">
    {#if activity}
      <ComposerActivity {activity} />
    {:else}
      <span class="min-w-0 flex-1 truncate" role="status">
        {#if promptRunning}Working{:else if agentControlState === "paused"}Agent paused{:else}Ready to continue{/if}
      </span>
    {/if}
    {#if hasControls}
      <div class="ml-auto grid w-23 shrink-0 grid-cols-3 items-center gap-1" data-agent-controls>
        {#if promptRunning}
          <button
            class="col-start-2 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            aria-label={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
            title={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
            disabled={agentControlState === "pause-requested" || agentControlState === "resuming"}
            onclick={onPause}
          >
            <Pause class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            class="col-start-3 grid h-7 w-7 shrink-0 place-items-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            aria-label="Stop response"
            title="Stop response"
            onclick={onCancel}
          >
            <Square class="h-3 w-3 fill-current" aria-hidden="true" />
          </button>
        {:else if canContinue}
          <button
            class="col-start-3 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            aria-label="Continue response"
            title="Continue response"
            onclick={onContinue}
          >
            <Play class="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
