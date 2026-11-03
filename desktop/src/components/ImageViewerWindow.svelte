<script lang="ts">
  import Maximize from "@lucide/svelte/icons/maximize";
  import X from "@lucide/svelte/icons/x";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { imageWindowPayload } from "../lib/image-window";
  import { iconButtonClass } from "../lib/icon-button";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import type { ZoomImage } from "./transcript-image-zoom";

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 16;
  const STEP = 1.25;

  let image = $state<ZoomImage>();
  let failed = $state(false);
  let closeButton: HTMLButtonElement | undefined;
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  /** null = fit to the window (never upscaled); otherwise a fixed scale of natural size. */
  let scale = $state<number | null>(null);
  const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));

  const fitScale = $derived(
    image && viewportWidth > 0 && viewportHeight > 0
      ? Math.min(1, (viewportWidth - 16) / image.width, (viewportHeight - 16) / image.height)
      : 1,
  );
  const effectiveScale = $derived(scale ?? fitScale);

  function unavailable(error: unknown): void {
    failed = true;
    diagnostics.warn("image-window:unavailable", error);
  }
  function close(): void {
    void getCurrentWindow().close().catch((error) => diagnostics.warn("image-window:close", error));
  }
  function zoom(factor: number): void {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, effectiveScale * factor));
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" || (event.metaKey && event.key.toLowerCase() === "w")) {
      event.preventDefault();
      close();
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1 / STEP);
    } else if (event.key === "1") {
      event.preventDefault();
      scale = 1;
    } else if (event.key === "0") {
      event.preventDefault();
      scale = null;
    }
  }
  onMount(() => {
    let disposed = false;
    closeButton?.focus({ preventScroll: true });
    void imageWindowPayload().then((payload) => { if (!disposed) image = payload; })
      .catch((error) => { if (!disposed) unavailable(error); });
    return () => { disposed = true; };
  });
</script>

<svelte:window onkeydown={keydown} />
<main class="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground" aria-label="Image viewer">
  <header data-tauri-drag-region class="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-popover px-2">
    <span data-tauri-drag-region class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{image?.alt || "Image"}</span>
    {#if image && !failed}
      <button class={iconButtonClass("md", "popover")} type="button" title="Zoom out (-)" aria-label="Zoom out" onclick={() => zoom(1 / STEP)}>
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <span class="w-11 text-center text-xs tabular-nums text-muted-foreground" role="status" aria-label="Zoom level">{Math.round(effectiveScale * 100)}%</span>
      <button class={iconButtonClass("md", "popover")} type="button" title="Zoom in (+)" aria-label="Zoom in" onclick={() => zoom(STEP)}>
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button class="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground" type="button" title="Actual size (1)" aria-label="Actual size" aria-pressed={scale === 1} onclick={() => { scale = 1; }}>
        1:1
      </button>
      <button class={iconButtonClass("md", "popover")} type="button" title="Fit to window (0)" aria-label="Fit to window" aria-pressed={scale === null} onclick={() => { scale = null; }}>
        <Maximize size={16} aria-hidden="true" />
      </button>
    {/if}
    <button bind:this={closeButton} class={iconButtonClass("md", "popover")} type="button" title="Close image (Esc)" aria-label="Close image" onclick={close}>
      <X size={16} aria-hidden="true" />
    </button>
  </header>
  <div class="flex min-h-0 flex-1 overflow-auto p-2" bind:clientWidth={viewportWidth} bind:clientHeight={viewportHeight}>
    {#if failed}
      <p role="status" class="m-auto text-sm text-muted-foreground">Image unavailable</p>
    {:else if image}
      <img
        class={scale === null ? "m-auto block h-auto w-auto max-h-full max-w-full object-contain" : "m-auto block max-w-none shrink-0"}
        style={scale === null ? undefined : `width: ${image.width * scale}px; height: ${image.height * scale}px`}
        src={image.src}
        alt={image.alt}
        onerror={() => unavailable("Image could not be loaded")}
      />
    {:else}
      <p role="status" class="m-auto text-xs text-muted-foreground">Loading image…</p>
    {/if}
  </div>
</main>
