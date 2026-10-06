<script lang="ts">
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { BtwStore } from "../app/btw.svelte";
  import type { createModelPreferencesStore } from "../app/model-preferences.svelte";
  import BtwModelControl from "./BtwModelControl.svelte";
  import BtwPane from "./BtwPane.svelte";

  let { store, sessionId, configOptions, preferences, mainPickerOpen = false, beforeModelOpen, ready, onInsert, onReturnFocus }: {
    store: BtwStore; sessionId: string | null;
    configOptions: readonly SessionConfigOption[]; ready: boolean;
    preferences: ReturnType<typeof createModelPreferencesStore>;
    mainPickerOpen?: boolean;
    beforeModelOpen?: () => void;
    onInsert: (sessionId: string, text: string) => boolean;
    onReturnFocus: () => void;
  } = $props();
  let marker = $state<HTMLSpanElement | null>(null);
  let pane = $state<{ focus: () => void } | null>(null);
  let width = $state(380);
  let availableWidth = $state(1200);
  const current = $derived(store.state(sessionId));

  export function focus(): void { pane?.focus(); }

  $effect(() => {
    const parent = marker?.parentElement;
    if (!parent) return;
    const measure = () => availableWidth = parent.clientWidth;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  });

  function selectText(id: string): void {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    // Only intentionally selected workbench text, never a main draft or hidden input.
    if (!selection || !element || !element.closest('[data-btw-workspace]') || element.closest('[data-btw-pane], input, textarea')) return;
    store.addExcerpt(id, { label: "Selected workbench text", text: selection.toString() });
  }
</script>

<span bind:this={marker} class="hidden" aria-hidden="true"></span>
{#if current && !current.hidden}
  {#key current.runtimeId}
    <BtwPane bind:this={pane} state={current} {ready} {width} {availableWidth}
      scrollTop={current.scrollTop}
      onWidthChange={(value) => width = value}
      onScroll={(top) => store.setScroll(current.sessionId, current.runtimeId, top)}
      onDraftChange={(text) => store.setDraft(current.sessionId, text)}
      onSend={() => store.send(current.sessionId)}
      onStop={() => store.stop(current.sessionId)}
      onClose={() => { store.hide(current.sessionId); onReturnFocus(); }}
      onNewConversation={() => store.newConversation(current.sessionId)}
      onAddSelectedText={() => selectText(current.sessionId)}
      onRemoveExcerpt={(index) => store.removeExcerpt(current.sessionId, index)}
      onInsertAnswer={(text) => onInsert(current.sessionId, text)}>
      {#snippet modelControl()}
        <BtwModelControl chat={current} {configOptions} {preferences} {ready} {mainPickerOpen}
          beforeOpen={beforeModelOpen} onSelect={(ref, effort) => store.setModelThinking(current.sessionId, ref, effort)}
          onFocusInput={() => pane?.focus()} />
      {/snippet}
    </BtwPane>
  {/key}
{/if}
