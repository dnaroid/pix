<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import StatusBarPopover from "./StatusBarPopover.svelte";
  import type { BrainstormStatus, SessionBrainstormSnapshot } from "../lib/session-brainstorm";

  let { snapshot, trailingSeparator = false, onOpenParticipant }: {
    snapshot?: SessionBrainstormSnapshot;
    trailingSeparator?: boolean;
    onOpenParticipant?: (sessionId: string) => void;
  } = $props();

  const labels: Record<BrainstormStatus, string> = {
    running: "Running",
    awaiting_synthesis: "Awaiting synthesis",
    awaiting_finalization: "Awaiting finalization",
    complete: "Complete",
    incomplete: "Incomplete",
  };
  const runs = $derived(snapshot?.runs ?? []);
  const current = $derived(
    runs.filter((run) => run.status !== "complete" && run.status !== "incomplete").at(-1) ?? runs.at(-1),
  );
</script>

{#if current}
  <div data-brainstorm-status>
  <StatusBarPopover label="Council status">
    {#snippet trigger({ open, toggle, id })}
    <button
      type="button"
      class={[
        "flex h-6 items-center gap-1 rounded-sm px-1 transition-colors hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        current.status === "incomplete" ? "text-tool-warning" : "text-muted-foreground",
        open && "bg-chrome-hover",
      ]}
      aria-label={`Open council. ${labels[current.status]}. Round ${current.round} of 5`}
      aria-haspopup="dialog"
      aria-controls={id}
      aria-expanded={open}
      onclick={toggle}
    >
      <Brain class={["h-3.5 w-3.5", current.status === "running" && "animate-pulse motion-reduce:animate-none"]} aria-hidden="true" />
      <span class="font-mono tabular-nums">{current.round}/5</span>
    </button>
    {/snippet}
    {#snippet children()}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard access to scrollable council details) -->
      <div class="max-h-[60vh] overflow-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md" tabindex="0" role="region" aria-label="Council details">
      {#each runs as run (run.runId)}
        <section class="space-y-1 py-1" aria-label={run.topic}>
          <div class="break-words font-medium">{run.topic}</div>
          <div class="text-muted-foreground">{labels[run.status]} · Round {run.round}/5</div>
          {#each run.participants as participant (participant.sessionId)}
            <div class="border-t border-border pt-1">
              <div class="break-words font-mono">P{participant.slot} · {participant.model}</div>
              <div class="text-muted-foreground">{participant.name} · {participant.status} · {participant.round}/5</div>
              {#if onOpenParticipant}
                <button type="button" class="mt-1 rounded-sm px-1 py-0.5 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Open participant ${participant.name}`} onclick={() => onOpenParticipant?.(participant.sessionId)}>Open session</button>
              {/if}
            </div>
          {/each}
        </section>
      {/each}
      </div>
    {/snippet}
  </StatusBarPopover>
  </div>
  {#if trailingSeparator}
    <span class="h-3 w-px shrink-0 bg-border" aria-hidden="true" data-status-separator="brainstorm-next"></span>
  {/if}
{/if}
