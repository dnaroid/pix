<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import type { SelectionAssistStore } from "../app/selection-assist.svelte";
  import { renderMarkdown } from "../lib/markdown";

  let { store }: { store: SelectionAssistStore } = $props();

  const WIDTH = 460;
  const MAX_HEIGHT = 380;
  const MARGIN = 12;
  const GAP = 6;
  const assist = $derived(store.state);
  const target = $derived(assist.target);
  const title = $derived(target?.action === "explain" ? "Explain Code" : "Translation");
  let viewportWidth = $state(window.innerWidth);
  let viewportHeight = $state(window.innerHeight);
  // Place on the side with more room and cap the height to that room so the
  // popover never leaves the window; above the selection it grows upward.
  const placement = $derived.by(() => {
    if (!target) return "";
    const left = Math.max(MARGIN, Math.min(target.anchor.left, viewportWidth - WIDTH - MARGIN));
    const below = viewportHeight - target.anchor.bottom - GAP - MARGIN;
    const above = target.anchor.top - GAP - MARGIN;
    const useBelow = below >= Math.min(MAX_HEIGHT, 200) || below >= above;
    const room = Math.max(120, Math.min(MAX_HEIGHT, useBelow ? below : above));
    const vertical = useBelow
      ? `top: ${Math.min(target.anchor.bottom + GAP, viewportHeight - room - MARGIN)}px;`
      : `bottom: ${Math.min(viewportHeight - target.anchor.top + GAP, viewportHeight - room - MARGIN)}px;`;
    return `left: ${left}px; ${vertical} max-height: ${room}px; width: min(${WIDTH}px, calc(100vw - ${MARGIN * 2}px));`;
  });
  let root = $state<HTMLElement | null>(null);

  function copy(): void {
    const text = assist.result;
    if (!text) return;
    void (isTauri() ? writeText(text) : navigator.clipboard.writeText(text)).catch(() => {});
  }
  function handleKeydown(event: KeyboardEvent): void {
    if (target && event.key === "Escape") { event.preventDefault(); store.close(); }
  }
  function handlePointerDown(event: PointerEvent): void {
    if (target && root && !root.contains(event.target as Node)) store.close();
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} onkeydown={handleKeydown} onpointerdown={handlePointerDown} />

{#if target}
  <div
    bind:this={root}
    class="selection-assist fixed z-[100] flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    style={placement}
    role="dialog"
    aria-label={title}
  >
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
      <span class="text-xs font-semibold">{title}</span>
      <span class="flex-1"></span>
      {#if assist.status === "done"}
        <button type="button" class="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onclick={copy}>Copy</button>
      {/if}
      <button type="button" class="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close" onclick={() => store.close()}>✕</button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-2.5 text-[13px] leading-[1.55]" aria-live="polite">
      {#if assist.status === "loading"}
        <p class="text-muted-foreground">{target.action === "explain" ? "Explaining…" : "Translating…"}</p>
      {:else if assist.status === "error"}
        <p class="text-tool-error">{assist.error}</p>
      {:else if assist.status === "done" || assist.status === "streaming"}
        <div class="assist-body markdown-text select-text">{@html renderMarkdown(assist.result)}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .assist-body :global(p),
  .assist-body :global(ul),
  .assist-body :global(ol),
  .assist-body :global(pre) { margin: 0 0 0.5rem; }
  .assist-body :global(:last-child) { margin-bottom: 0; }
  .assist-body :global(ul) { list-style: disc; padding-left: 1.1rem; }
  .assist-body :global(ol) { list-style: decimal; padding-left: 1.3rem; }
  .assist-body :global(li + li) { margin-top: 0.2rem; }
  .assist-body :global(li::marker) { color: var(--muted-foreground); }
  .assist-body :global(code) {
    font-size: 0.92em;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    background: var(--muted);
  }
  .assist-body :global(pre) {
    overflow-x: auto;
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    background: var(--muted);
  }
  .assist-body :global(pre code) { padding: 0; background: none; }
  .assist-body :global(strong) { font-weight: 600; }
</style>
