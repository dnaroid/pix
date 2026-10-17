<script lang="ts">
  import type { Snippet } from "svelte";
  import type { UsageTooltipAnchor } from "./usage-interaction";

  /**
   * Instant Pix-styled chart tooltip. Positioned (fixed) above the anchor,
   * flipped below when there is no room and clamped to the viewport. Any
   * scroll or resize dismisses it so it never floats over stale geometry.
   */
  let { anchor, onDismiss, children }: {
    anchor: UsageTooltipAnchor | null;
    onDismiss: () => void;
    children: Snippet;
  } = $props();

  const MARGIN = 6;
  let element = $state<HTMLElement | null>(null);
  let size = $state<{ width: number; height: number } | null>(null);

  $effect(() => {
    void anchor;
    if (!element) { size = null; return; }
    const rect = element.getBoundingClientRect();
    size = { width: rect.width, height: rect.height };
  });

  $effect(() => {
    if (!anchor) return;
    const dismiss = () => onDismiss();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  });

  const position = $derived.by(() => {
    if (!anchor || !size) return null;
    const viewportWidth = window.innerWidth;
    const centered = anchor.left + anchor.width / 2 - size.width / 2;
    const left = Math.min(Math.max(MARGIN, centered), Math.max(MARGIN, viewportWidth - size.width - MARGIN));
    const above = anchor.top - size.height - MARGIN;
    const top = above >= MARGIN ? above : anchor.top + anchor.height + MARGIN;
    return { left, top };
  });
</script>

{#if anchor}
  <div
    bind:this={element}
    class="pointer-events-none fixed z-50 max-w-[260px] rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-4 text-popover-foreground shadow-md"
    style:left={`${position?.left ?? 0}px`}
    style:top={`${position?.top ?? 0}px`}
    style:visibility={position ? "visible" : "hidden"}
    role="tooltip"
  >{@render children()}</div>
{/if}
