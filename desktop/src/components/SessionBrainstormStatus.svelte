<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import type { BrainstormStatus, SessionBrainstormSnapshot } from "../lib/session-brainstorm";

  let { snapshot, open = false, onOpen }: {
    snapshot?: SessionBrainstormSnapshot;
    open?: boolean;
    onOpen: () => void;
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
  const tooltipId = $props.id();
</script>

{#if current}
  <div class="group relative shrink-0" data-brainstorm-status>
    <button
      type="button"
      class={[
        "flex h-6 items-center gap-1 rounded-sm px-1 transition-colors hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        current.status === "incomplete" ? "text-tool-warning" : "text-muted-foreground",
        open && "bg-chrome-hover",
      ]}
      aria-label={`Open council. ${labels[current.status]}. Round ${current.round} of 5`}
      aria-describedby={tooltipId}
      aria-expanded={open}
      onclick={onOpen}
    >
      <Brain class={["h-3.5 w-3.5", current.status === "running" && "animate-pulse motion-reduce:animate-none"]} aria-hidden="true" />
      <span class="font-mono tabular-nums">{current.round}/5</span>
    </button>
    <div
      id={tooltipId}
      role="tooltip"
      class="absolute right-0 bottom-full z-40 hidden max-h-[60vh] w-80 max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md group-hover:block group-focus-within:block"
    >
      {#each runs as run (run.runId)}
        <section class="space-y-1 py-1" aria-label={run.topic}>
          <div class="break-words font-medium">{run.topic}</div>
          <div class="text-muted-foreground">{labels[run.status]} · Round {run.round}/5</div>
          {#each run.participants as participant (participant.sessionId)}
            <div class="border-t border-border pt-1">
              <div class="break-words font-mono">P{participant.slot} · {participant.model}</div>
              <div class="text-muted-foreground">{participant.name} · {participant.status} · {participant.round}/5</div>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
{/if}
