<script lang="ts" module>
  /** Last known terminal state per viewer session, so remounts never flash "Checking…". */
  const lastTerminalBySession = new Map<string, boolean>();
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import type { SubagentSessionState } from "../lib/session-subagent-link";

  const POLL_INTERVAL_MS = 2_000;

  let { sessionId, agentId, runName, poll, onContinue, onOpenParent }: {
    sessionId: string;
    agentId: string;
    runName: string;
    /** Resolves undefined when polling should stop (tab switched, error). */
    poll: () => Promise<SubagentSessionState | undefined>;
    onContinue: () => void;
    onOpenParent?: () => void;
  } = $props();

  let terminal = $state<boolean | undefined>(untrack(() => lastTerminalBySession.get(sessionId)));
  // Spread props re-trigger readers whenever the parent rebuilds the prop
  // object; a derived primitive only changes when the id really changes.
  const viewerSessionId = $derived(sessionId);

  // One polling owner per viewer session; keyed by sessionId so a tab switch
  // tears it down. Stops after the agent is terminal or polling fails.
  $effect(() => {
    const id = viewerSessionId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    untrack(() => { terminal = lastTerminalBySession.get(id); });
    const tick = async (): Promise<void> => {
      const state = await untrack(() => poll());
      if (disposed) return;
      if (state) {
        lastTerminalBySession.delete(id);
        lastTerminalBySession.set(id, state.terminal);
        while (lastTerminalBySession.size > 32) lastTerminalBySession.delete(lastTerminalBySession.keys().next().value!);
      }
      terminal = state?.terminal ?? terminal;
      if (state && !state.terminal) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

<div
  class="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground"
  role="status"
  data-subagent-viewer-banner
>
  <span class="min-w-0 truncate">
    Sub-agent <span class="font-mono text-foreground">{agentId}</span> · {runName} ·
    {terminal === undefined ? "Checking…" : terminal ? "Finished" : "Running"} — read only
  </span>
  <span class="flex shrink-0 items-center gap-1">
    {#if onOpenParent}
      <button
        type="button"
        class="rounded px-2 py-1 text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"
        onclick={onOpenParent}
      >Open parent</button>
    {/if}
    <button
      type="button"
      class="rounded px-2 py-1 text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"
      data-subagent-continue
      onclick={onContinue}
    >Continue in new session</button>
  </span>
</div>
