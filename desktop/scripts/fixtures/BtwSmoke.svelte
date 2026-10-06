<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { Attachment } from "../../src/lib/attachments";
  import type { BtwCommand, BtwEvent, BtwState, BtwThinkingLevel } from "../../../acp/src/btw/contract";
  import { createBtwStore } from "../../src/app/btw.svelte";
  import { canInsertBtwDraft, btwDiscussionDraft } from "../../src/app/btw-draft";
  import { createPromptSubmit } from "../../src/app/prompt-submit";
  import { DESKTOP_SLASH_COMMANDS } from "../../src/lib/slash-commands";
  import PromptComposer from "../../src/components/PromptComposer.svelte";
  import BtwDock from "../../src/components/BtwDock.svelte";
  import ModelThinkingPicker from "../../src/components/ModelThinkingPicker.svelte";
  import { createModelPreferencesStore } from "../../src/app/model-preferences.svelte";
  import { modelThinkingConfigState } from "../../src/lib/model-thinking";

  let sessionId = $state("a");
  let mainDraft = $state("Keep this main draft");
  let attachments = $state<Attachment[]>([]);
  let mainPickerOpen = $state(false);
  let dock: { focus: () => void };
  let composer: { focus: () => Promise<void> };
  const calls: Array<{ sessionId: string; command: BtwCommand }> = [];
  const errors: string[] = [];
  const preferences = createModelPreferencesStore({ reportError: (error) => errors.push(String(error)) });
  let parentCancels = 0;
  let parentSubmits = 0;
  const backend = new Map<string, BtwState>();
  const active = new Map<string, { requestId: string; sequence: number; model: string; effort: BtwThinkingLevel }>();
  const initial = (id: string): BtwState => backend.get(id) ?? { runtimeId: `runtime-${id}`, contextKey: `context-${id}`, busyRequestId: null };
  function publish(id: string, text: string, phase: BtwEvent["phase"] = "done"): void {
    const request = active.get(id); if (!request) return;
    const identity = initial(id);
    const next = { ...identity, busyRequestId: phase === "streaming" ? request.requestId : null };
    backend.set(id, next);
    store.handleSessionState({ sessionId: id, channel: "btw", data: { version: 1, runtimeId: identity.runtimeId, requestId: request.requestId,
      sequence: ++request.sequence, phase, text, modelRef: request.model, thinkingLevel: request.effort, busyRequestId: next.busyRequestId,
      context: { key: identity.contextKey, capturedAt: Date.now(), records: 8, inputChars: 4000, truncated: false, historyReset: false },
      ...(phase === "done" ? { usage: { inputTokens: 100, outputTokens: 20 } } : {}) } });
  }
  const store = createBtwStore({ runtimeReady: () => true, command: async (id, command) => {
    calls.push({ sessionId: id, command });
    if (command.action === "ask") {
      active.set(id, { requestId: command.requestId, sequence: 0, model: command.modelRef ?? "fixture/main", effort: command.thinkingLevel ?? "high" });
      backend.set(id, { ...initial(id), busyRequestId: command.requestId });
      publish(id, "", "streaming");
    } else if (command.action === "cancel") publish(id, "", "cancelled");
    return initial(id);
  } });

  async function openBtw(id: string, question?: string) {
    await store.open(id); await tick(); if (sessionId === id) dock.focus();
    if (question) { store.setDraft(id, question); await store.send(id); }
  }
  const unexpected = () => { parentSubmits++; throw new Error("Unexpected parent pipeline"); };
  const submit = createPromptSubmit({
    client: () => ({ prompt: unexpected }), sessionMutationRunning: () => false, sessionHistoryLoading: () => false,
    waitForAttachmentDraftSettled: async () => {}, attachmentDraftKey: () => sessionId, attachmentGeneration: () => 1,
    promptText: () => mainDraft, promptAttachments: () => attachments, setPromptText: (text: string) => mainDraft = text,
    activeSessionId: () => sessionId, sessionRuntimeReady: () => true, promptRunning: () => true,
    openBtw, invalidateAttachmentDraft: () => {}, appendUserMessage: unexpected, queueDraftForCurrentRun: unexpected,
    materializeDraftSession: unexpected, prompts: { runPromptRequest: unexpected }, reportError: (error: unknown) => errors.push(String(error)),
  } as unknown as Parameters<typeof createPromptSubmit>[0]);
  const models: SessionConfigOption[] = [{ id: "model", name: "Model", type: "select", currentValue: "fixture/main", options: [
    { value: "fixture/main", name: "Main model", _meta: { "pix.thinkingLevels": ["off", "minimal", "low", "medium", "high"] } },
    { value: "fixture/fast", name: "Fast model", _meta: { "pix.thinkingLevels": ["off", "low", "high"] } },
    { value: "fixture/no-thinking", name: "No thinking model", _meta: { "pix.thinkingLevels": ["off"] } },
    { value: "fixture/hidden", name: "Hidden model", _meta: { "pix.thinkingLevels": ["off", "high"] } },
  ] }, { id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [
    { value: "off", name: "off" }, { value: "minimal", name: "minimal" }, { value: "low", name: "low" },
    { value: "medium", name: "medium" }, { value: "high", name: "high" },
  ] }];
  async function openMainPicker() {
    if (mainPickerOpen) { mainPickerOpen = false; return; }
    await preferences.waitForVisibleModelsSave(); await preferences.load(); mainPickerOpen = true;
  }
  onMount(() => {
    Object.assign(window, { btwSmoke: { calls, errors, snapshot: (id = sessionId) => store.state(id), publish,
      switchSession: (id: string) => { sessionId = id; }, closeSession: () => store.clearSession(sessionId),
      reset: () => store.reset(), counts: () => ({ parentSubmits, parentCancels }),
      parentSelection: () => ({ model: modelThinkingConfigState(models).currentModel?.ref, effort: modelThinkingConfigState(models).currentThinking }),
      setDraft: (text: string) => mainDraft = text,
      addMainAttachment: () => attachments = [{ id: "attachment", name: "do-not-touch.txt", kind: "file", path: "/synthetic/do-not-touch.txt" } as Attachment],
      clearMainAttachments: () => attachments = [],
    } });
  });
  onDestroy(store.reset);
</script>

<div class="flex h-screen flex-col bg-background text-foreground">
  <header class="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-chrome px-3 text-xs">
    <strong>Pix · BTW fixture</strong><span>Parent session {sessionId} · Running</span>
    <button onclick={() => sessionId = sessionId === "a" ? "b" : "a"}>Switch parent</button>
  </header>
  <div class="flex min-h-0 min-w-0 flex-1" data-btw-workspace>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-auto p-5 text-sm">
        <p class="mb-4 text-muted-foreground">The main agent continues working. Its draft and attachments are independent.</p>
        <pre id="selected-code" class="select-text whitespace-pre-wrap rounded border border-border p-3 font-mono text-xs">const queue = new Map();
// Preserve request ordering and cancellation.</pre>
      </div>
      <PromptComposer bind:this={composer} bind:promptText={mainDraft} {attachments} activeSessionId={sessionId} ready={true}
        promptRunning={true} agentControlState="running" dragActive={false} autocompleteEnabled={false} autocompleteDebounceMs={0}
        availableCommands={DESKTOP_SLASH_COMMANDS} onAutocomplete={async () => ""} onSubmit={submit.submit} onDefer={unexpected}
        onCancel={() => parentCancels++} onChooseAttachments={() => {}} onPasteAttachments={() => {}} onRemoveAttachment={() => {}}
        onOpenAttachment={() => {}} onOpenBtw={() => openBtw(sessionId)} />
    </div>
    <BtwDock bind:this={dock} {store} {sessionId} configOptions={models} ready={true} {preferences}
      {mainPickerOpen} beforeModelOpen={() => mainPickerOpen = false}
      onReturnFocus={() => void composer.focus()}
      onInsert={(owner, text) => {
        if (!canInsertBtwDraft(owner, sessionId, true, false, mainDraft, attachments)) return false;
        mainDraft = btwDiscussionDraft(text); void composer.focus(); return true;
      }} />
  </div>
  <footer class="flex h-7 shrink-0 items-center border-t border-border bg-chrome px-3 text-xs text-muted-foreground">
    <button data-model-thinking-trigger aria-label="Main model and effort" onclick={() => void openMainPicker()}>Main model · high</button>
    <span class="ml-3">Synthetic model/IPC · Real components and slash dispatch</span>
  </footer>
</div>
{#if mainPickerOpen}
  <ModelThinkingPicker configOptions={models} visibleModelRefs={preferences.visibleModelRefs}
    rememberedThinkingByModel={preferences.rememberedThinkingByModel} onSetDefault={preferences.saveDefaultSelection}
    onVisibleModelsChange={preferences.saveVisibleModelRefs} onApply={unexpected} onClose={() => mainPickerOpen = false} />
{/if}
