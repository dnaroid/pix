<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import ObserverStatus from "../../src/components/ObserverStatus.svelte";
  import SettingsPanel from "../../src/components/SettingsPanel.svelte";
  import { createHeadsUpStore } from "../../src/app/heads-up.svelte";
  import { DEFAULT_HEADS_UP_CONFIG } from "../../../src/bundled-extensions/heads-up/config";
  import type { HeadsUpSnapshot } from "../../src/lib/heads-up";
  import type { AcpClient } from "../../src/lib/acp-client";

  let sessionId = $state<string | null>("session-a");
  let ready = $state(true);
  let settingsOpen = $state(false);
  let settingsPanel: { openSection: (id: string) => Promise<void> };
  const calls: string[] = [];
  const errors: string[] = [];
  const bySession = new Map<string, HeadsUpSnapshot>();
  function initial(id: string): HeadsUpSnapshot {
    return { version: 1, instanceId: `runtime-${id}`, revision: 1, enabled: false, model: "provider/observer-model", phase: "off", checks: 0, inputTokens: 0, outputTokens: 0, notice: null,
      details: { config: { ...DEFAULT_HEADS_UP_CONFIG }, newTurns: 0, intervalEligibleAt: Date.now() + 60000, checksInWindow: 0, inputCharsInWindow: 0, windowResetsAt: null, lastCheck: null } };
  }
  const client = { prompt: async (id: string, blocks: { text: string }[]) => {
    const command = blocks[0]?.text ?? ""; calls.push(command);
    const state = bySession.get(id)!;
    if (command === "/heads-up on") publish(id, { enabled: true, phase: "idle" });
    else if (command === "/heads-up off") publish(id, { enabled: false, phase: "off", notice: null, details: { ...state.details!, lastCheck: state.details!.lastCheck ? { ...state.details!.lastCheck, result: "cancelled", finishedAt: Date.now(), durationMs: 3 } : null } });
    else if (command === "/heads-up check") publish(id, { phase: "checking", checks: state.checks + 1, details: { ...state.details!, lastCheck: { startedAt: Date.now(), finishedAt: null, durationMs: null, result: "running" } } });
    else if (command === "/heads-up snapshot") publish(id, {});
    else throw new Error("Unexpected command");
  } } as unknown as AcpClient;
  const store = createHeadsUpStore({ client: () => client, runtimeReady: () => ready, commandAvailable: () => true, reportError: (error) => errors.push(String(error)) });
  function publish(id: string, patch: Partial<HeadsUpSnapshot>): void {
    const previous = bySession.get(id) ?? initial(id);
    const next = { ...previous, ...patch, revision: previous.revision + 1 };
    bySession.set(id, next);
    store.handleSessionState({ sessionId: id, channel: "heads-up", data: next });
  }
  async function openSettings(): Promise<void> {
    settingsOpen = true;
    await tick();
    await settingsPanel.openSection("desktop-observer");
  }
  const modelOptions = [{ id: "model", name: "Model", type: "select" as const, currentValue: "provider/main-model", options: [
    { value: "provider/main-model", name: "Main Model" },
    { value: "provider/observer-model", name: "Observer Model" },
  ] }];
  onMount(() => {
    publish("session-a", {}); publish("session-b", {});
    Object.assign(window, { observerSmoke: {
      calls, errors,
      setSession: (id: string | null) => sessionId = id,
      setReady: (value: boolean) => ready = value,
      publish: (patch: Partial<HeadsUpSnapshot>) => publish(sessionId!, patch),
      snapshot: () => store.state(sessionId),
      closeSettings: () => settingsOpen = false,
    } });
  });
  onDestroy(() => store.reset());
</script>

<main style="height:100vh;padding:12px" class="bg-background text-foreground">
  <h1 class="text-sm">Observer integration fixture — synthetic state, no provider calls</h1>
  <textarea aria-label="Main draft" class="mt-3 rounded border border-border p-2 text-xs">Keep this draft</textarea>
  <button id="outside" type="button">Outside target</button>
  {#if settingsOpen}
    <div style="display:grid;height:70vh;width:min(38rem,95vw);overflow:hidden" class="mt-3 border border-border">
      <SettingsPanel bind:this={settingsPanel} configOptions={modelOptions} onOpenUserConfig={() => {}} />
    </div>
  {/if}
</main>
<footer style="position:fixed;bottom:0;left:0;right:0;height:28px;display:flex;align-items:center;padding:0 8px" class="border-t border-border bg-chrome text-xs text-muted-foreground">
  <ObserverStatus {sessionId} runtimeReady={ready} snapshot={store.state(sessionId)}
    pendingToggle={store.isPending(sessionId, "/heads-up on") || store.isPending(sessionId, "/heads-up off")}
    pendingCheck={store.isPending(sessionId, "/heads-up check")}
    onToggle={() => { if (sessionId) void store.sendControl(sessionId, store.state(sessionId)?.enabled ? "off" : "on"); }}
    onCheck={() => { if (sessionId) void store.sendControl(sessionId, "check"); }}
    onRequestSnapshot={() => { if (sessionId) void store.requestSnapshot(sessionId); }}
    onOpenSettings={() => void openSettings()} />
</footer>
