<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { imageWindowPayload } from "../lib/image-window";
  import { iconButtonClass } from "../lib/icon-button";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import type { ZoomImage } from "./transcript-image-zoom";

  let image = $state<ZoomImage>();
  let failed = $state(false);
  let closeButton: HTMLButtonElement | undefined;
  const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
  function unavailable(error: unknown): void {
    failed = true;
    diagnostics.warn("image-window:unavailable", error);
  }
  function close(): void {
    void getCurrentWindow().close().catch((error) => diagnostics.warn("image-window:close", error));
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" || (event.metaKey && event.key.toLowerCase() === "w")) {
      event.preventDefault();
      close();
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
  <header data-tauri-drag-region class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-popover px-2">
    <span data-tauri-drag-region class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{image?.alt || "Image"}</span>
    <button bind:this={closeButton} class={iconButtonClass("md", "popover")} type="button" title="Close image (Esc)" aria-label="Close image" onclick={close}>
      <X size={16} aria-hidden="true" />
    </button>
  </header>
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
    {#if failed}
      <p role="status" class="text-sm text-muted-foreground">Image unavailable</p>
    {:else if image}
      <img class="block h-auto w-auto max-h-full max-w-full object-contain" src={image.src} alt={image.alt} onerror={() => unavailable("Image could not be loaded")} />
    {:else}
      <p role="status" class="text-xs text-muted-foreground">Loading image…</p>
    {/if}
  </div>
</main>
