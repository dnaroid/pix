<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import FileCode from "@lucide/svelte/icons/file-code";
  import MoveDiagonal2 from "@lucide/svelte/icons/move-diagonal-2";
  import WrapText from "@lucide/svelte/icons/wrap-text";
  import X from "@lucide/svelte/icons/x";
  import type { Attachment } from "../lib/attachments";
  import type { PreviewScrollPosition } from "../lib/preview-history";
  import type { ProjectFilePreview } from "../lib/project-files";
  import { highlightCode, languageForFilePath } from "../lib/syntax-highlight";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    attachment,
    file,
    previewId,
    scrollPosition,
    canGoBack = false,
    canGoForward = false,
    onBack,
    onForward,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
    onScrollPositionChange,
    onClose,
  }: {
    attachment?: Attachment;
    file?: ProjectFilePreview;
    previewId: number;
    scrollPosition: PreviewScrollPosition;
    canGoBack?: boolean;
    canGoForward?: boolean;
    onBack?: () => void;
    onForward?: () => void;
    onOpenProjectFile?: (path: string) => void | Promise<void>;
    onResolveProjectMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onResolveLocalMedia?: (path: string) => Promise<Attachment | undefined>;
    onScrollPositionChange?: (id: number, position: PreviewScrollPosition) => void;
    onClose: () => void;
  } = $props();

  let dialogElement: HTMLDialogElement | undefined;
  let previewElement: HTMLDivElement | undefined;
  let contentScrollElement = $state<HTMLDivElement | undefined>();
  let closeButton: HTMLButtonElement | undefined;
  let wrapLines = $state(false);
  let resizeStart: {
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | undefined;

  const title = $derived(file?.path ?? attachment?.name ?? "Preview");
  const source = $derived(
    attachment?.dataUrl ?? (attachment?.path ? convertFileSrc(attachment.path) : ""),
  );
  const language = $derived(file ? languageForFilePath(file.path) : undefined);
  const renderAsMarkdown = $derived(language === "markdown");
  const highlighted = $derived(
    file && !renderAsMarkdown ? highlightCode(file.content, language) : undefined,
  );

  function projectLinkPath(path: string): string {
    const normalizedFilePath = file?.path.replaceAll("\\", "/");
    const directory = normalizedFilePath?.includes("/")
      ? normalizedFilePath.slice(0, normalizedFilePath.lastIndexOf("/"))
      : "";
    return directory ? `${directory}/${path}` : path;
  }

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    dialog.showModal();
    const focusFrame = requestAnimationFrame(() => closeButton?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => previouslyFocused?.focus());
    };
  });

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }

  function restoreScroll(
    node: HTMLElement,
    initial: { key: number; position: PreviewScrollPosition },
  ): { update: (next: { key: number; position: PreviewScrollPosition }) => void; destroy: () => void } {
    let key = initial.key;
    let frame = 0;

    function schedule(position: PreviewScrollPosition): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.scrollLeft = position.left;
        node.scrollTop = position.top;
      });
    }

    schedule(initial.position);
    return {
      update(next): void {
        if (next.key === key) return;
        key = next.key;
        schedule(next.position);
      },
      destroy(): void {
        cancelAnimationFrame(frame);
      },
    };
  }

  function rememberScroll(): void {
    if (!contentScrollElement) return;
    onScrollPositionChange?.(previewId, {
      left: contentScrollElement.scrollLeft,
      top: contentScrollElement.scrollTop,
    });
  }

  function handleBack(): void {
    rememberScroll();
    onBack?.();
  }

  function handleForward(): void {
    rememberScroll();
    onForward?.();
  }

  function openProjectFromMarkdown(path: string): void | Promise<void> {
    rememberScroll();
    return onOpenProjectFile?.(projectLinkPath(path));
  }

  function openLocalFromMarkdown(path: string): void | Promise<void> {
    rememberScroll();
    return onOpenLocalFile?.(path);
  }

  function handleCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }

  function setPreviewSize(width: number, height: number): void {
    if (!previewElement) return;
    const maxWidth = window.innerWidth - 48;
    const maxHeight = window.innerHeight - 48;
    const minWidth = Math.min(480, maxWidth);
    const minHeight = Math.min(320, maxHeight);
    previewElement.style.width = `${Math.max(minWidth, Math.min(width, maxWidth))}px`;
    previewElement.style.height = `${Math.max(minHeight, Math.min(height, maxHeight))}px`;
  }

  function handleResizeStart(event: PointerEvent): void {
    if (!previewElement || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    const bounds = previewElement.getBoundingClientRect();
    resizeStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: PointerEvent): void {
    if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
    // The panel stays centered, so each dimension changes on both sides.
    setPreviewSize(
      resizeStart.width + (event.clientX - resizeStart.x) * 2,
      resizeStart.height + (event.clientY - resizeStart.y) * 2,
    );
  }

  function handleResizeEnd(event: PointerEvent): void {
    if (resizeStart?.pointerId === event.pointerId) resizeStart = undefined;
  }

  function handleResizeKey(event: KeyboardEvent): void {
    if (!previewElement) return;
    const step = event.shiftKey ? 64 : 24;
    const widthDelta = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const heightDelta = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    if (widthDelta === 0 && heightDelta === 0) return;
    event.preventDefault();
    const bounds = previewElement.getBoundingClientRect();
    setPreviewSize(bounds.width + widthDelta, bounds.height + heightDelta);
  }
</script>

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-40 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-6 text-foreground backdrop:bg-overlay backdrop:backdrop-blur-sm open:grid"
  aria-label={`Preview ${title}`}
  oncancel={handleCancel}
  onclick={handleBackdropClick}
>
  <div
    bind:this={previewElement}
    class="relative flex h-[760px] max-h-[calc(100vh-48px)] min-h-[320px] w-[1120px] max-w-[calc(100vw-48px)] min-w-[480px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
  >
    <header class="flex min-h-10 min-w-0 items-center gap-2 border-b border-border px-3">
      <div class="flex shrink-0 items-center gap-0.5" aria-label="Preview history">
        <button
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground/35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/35"
          type="button"
          aria-label="Go back"
          title="Back"
          disabled={!canGoBack}
          onclick={handleBack}
        >
          <ArrowLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground/35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/35"
          type="button"
          aria-label="Go forward"
          title="Forward"
          disabled={!canGoForward}
          onclick={handleForward}
        >
          <ArrowRight class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {#if file}
        <FileCode class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <strong class="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</strong>
      {#if renderAsMarkdown}
        <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Markdown
        </span>
      {:else if highlighted}
        <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {highlighted.language}
        </span>
        <button
          class={wrapLines
            ? "grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            : "grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"}
          type="button"
          aria-label="Wrap long lines"
          aria-pressed={wrapLines}
          title={wrapLines ? "Disable line wrapping" : "Wrap long lines"}
          onclick={() => wrapLines = !wrapLines}
        >
          <WrapText class="h-4 w-4" aria-hidden="true" />
        </button>
      {/if}
      <button
        class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        aria-label="Close preview"
        title="Close preview"
        bind:this={closeButton}
        onclick={onClose}
      >
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </header>
    {#if file}
      {#if renderAsMarkdown}
        {#key previewId}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex Scrollable preview needs keyboard focus. -->
          <div
            bind:this={contentScrollElement}
            use:restoreScroll={{ key: previewId, position: scrollPosition }}
            class="min-h-0 min-w-0 flex-1 overflow-auto bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            role="region"
            aria-label={`Rendered Markdown for ${file.path}`}
            tabindex="0"
            onscroll={rememberScroll}
          >
            <div class="mx-auto w-full max-w-[840px] px-8 py-6 text-sm leading-6">
              <MarkdownText
                text={file.content}
                fitTables
                remoteImages
                headingAnchors
                onOpenProjectFile={openProjectFromMarkdown}
                onResolveProjectMedia={(path) => onResolveProjectMedia?.(projectLinkPath(path)) ?? Promise.resolve(undefined)}
                onOpenLocalFile={openLocalFromMarkdown}
                {onResolveLocalMedia}
              />
            </div>
          </div>
        {/key}
      {:else if highlighted}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex Scrollable source needs keyboard focus. -->
        <div
          bind:this={contentScrollElement}
          use:restoreScroll={{ key: previewId, position: scrollPosition }}
          class="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="region"
          aria-label={`Source for ${file.path}`}
          tabindex="0"
          onscroll={rememberScroll}
        >
          <pre class={wrapLines
            ? "m-0 min-h-full w-full min-w-0 py-3 font-mono text-xs leading-6 text-foreground"
            : "m-0 min-h-full min-w-full w-max py-3 font-mono text-xs leading-6 text-foreground"}><code class:wrap-lines={wrapLines} class="preview-code">{@html highlighted.html}</code></pre>
        </div>
      {/if}
    {:else if attachment}
      <div class="grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden bg-background p-3">
        {#if attachment.kind === "image"}
          <img class="max-h-[calc(100vh-112px)] max-w-[calc(100vw-72px)] object-contain" src={source} alt={attachment.name} />
        {:else}
        <!-- svelte-ignore a11y_media_has_caption User-selected videos do not necessarily include a captions track. -->
          <video
            class="max-h-[calc(100vh-112px)] max-w-[calc(100vw-72px)]"
            src={source}
            controls
          ></video>
        {/if}
      </div>
    {/if}
    <button
      class="absolute right-0 bottom-0 z-20 grid h-8 w-8 touch-none cursor-se-resize place-items-center rounded-tl-md text-muted-foreground transition-colors select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring"
      type="button"
      aria-label="Resize preview"
      title="Drag to resize preview; arrow keys also work"
      onpointerdown={handleResizeStart}
      onpointermove={handleResizeMove}
      onpointerup={handleResizeEnd}
      onpointercancel={handleResizeEnd}
      onkeydown={handleResizeKey}
    >
      <MoveDiagonal2 class="h-4 w-4" aria-hidden="true" />
    </button>
  </div>
</dialog>

<style>
  .preview-code {
    display: block;
    min-width: 100%;
    counter-reset: preview-line;
    tab-size: 2;
    white-space: normal;
  }

  .preview-code :global(.sh__line) {
    display: block;
    min-height: 1.5rem;
    min-width: 100%;
    width: max-content;
    padding-right: 1rem;
    white-space: pre;
  }

  .preview-code :global(.sh__line)::before {
    position: sticky;
    left: 0;
    display: inline-block;
    width: 3.5rem;
    margin-right: 1rem;
    border-right: 1px solid var(--border);
    background: var(--muted);
    color: var(--muted-foreground);
    content: counter(preview-line);
    counter-increment: preview-line;
    font-variant-numeric: tabular-nums;
    text-align: right;
    padding-right: 0.75rem;
    text-indent: 0;
    user-select: none;
  }

  .preview-code.wrap-lines :global(.sh__line) {
    position: relative;
    min-width: 0;
    width: 100%;
    padding-left: 4.5rem;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .preview-code.wrap-lines :global(.sh__line)::before {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    height: auto;
    margin-right: 0;
  }
</style>
