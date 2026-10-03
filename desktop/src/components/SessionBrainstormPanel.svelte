<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import type { BrainstormParticipantStatus, SessionBrainstormSnapshot } from "../lib/session-brainstorm";

  let {
    snapshot,
    onOpenParticipant,
  }: {
    snapshot: SessionBrainstormSnapshot | undefined;
    onOpenParticipant: (sessionId: string) => void | Promise<void>;
  } = $props();

  function statusTone(status: BrainstormParticipantStatus): string {
    if (status === "running") return "text-tool-info";
    if (status === "done") return "text-tool-success";
    if (status === "failed") return "text-tool-error";
    if (status === "stopped") return "text-muted-foreground";
    return "text-tool-warning";
  }
</script>

{#if snapshot?.runs.length}
  <section class="border-b border-border" aria-label="Brainstorm runs" data-brainstorm-panel>
    <h3 class="flex h-8 items-center gap-1.5 px-2.5 text-xs font-semibold">
      <Brain class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      Brainstorm
      <span class="ml-auto font-mono font-normal text-muted-foreground">{snapshot.runs.length} runs</span>
    </h3>
    {#each snapshot.runs as run (run.runId)}
      <article class="border-t border-border px-2.5 py-2" aria-label={`Brainstorm ${run.runId}`}>
        <div class="flex min-w-0 items-center gap-2 text-xs">
          <span class="min-w-0 flex-1 truncate font-medium" title={run.topic}>{run.topic || "Untitled brainstorm"}</span>
          <span class="shrink-0 text-muted-foreground">{run.status.replaceAll("_", " ")}</span>
        </div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={`${run.runId} · ${run.runDir}`}>
          {run.runId} · round {run.round}
        </div>
        <ul class="mt-1.5 space-y-0.5">
          {#each run.participants as participant (participant.sessionId)}
            <li class="flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-1 text-xs hover:bg-panel-hover">
              <span class={statusTone(participant.status)} aria-label={participant.status}>●</span>
              <span class="min-w-0 flex-1 truncate" title={`${participant.name} · ${participant.model}`}>
                {participant.name || `Participant ${participant.slot + 1}`}
              </span>
              <span class="shrink-0 font-mono text-muted-foreground">r{participant.round}</span>
              <button
                type="button"
                class="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-muted-foreground hover:bg-panel-selected hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Open ${participant.name || `participant ${participant.slot + 1}`} session`}
                title="Open participant session"
                onclick={() => void onOpenParticipant(participant.sessionId)}
              >Open <ExternalLink class="h-3 w-3" aria-hidden="true" /></button>
            </li>
          {/each}
        </ul>
      </article>
    {/each}
  </section>
{/if}
