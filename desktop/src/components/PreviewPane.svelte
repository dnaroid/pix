<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Check from "@lucide/svelte/icons/check";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Pencil from "@lucide/svelte/icons/pencil";
  import WrapText from "@lucide/svelte/icons/wrap-text";
  import type { Attachment } from "../lib/attachments";
  import type { PreviewScrollPosition } from "../lib/preview-history";
  import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
  import { highlightCode, languageForFilePath } from "../lib/syntax-highlight";
  import MarkdownText from "./MarkdownText.svelte";
  import { createPreviewEditorController } from "./preview-editor-controller.svelte";
  import { createPreviewMarkdownController } from "./preview-markdown-controller.svelte";
  import { createPreviewScrollController } from "./preview-scroll-controller.svelte";

  let {
    attachment,
    file,
    lineRange,
    previewId,
    scrollPosition,
    canGoBack = false,
    canGoForward = false,
    editable = false,
    externalEditorLabel,
    onBack,
    onForward,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
    onSaveProjectFile,
    onOpenExternalEditor,
    onScrollPositionChange,
    onDirtyChange,
    onClose,
  }: {
    attachment?: Attachment;
    file?: ProjectFilePreview;
    lineRange?: ProjectFileLineRange;
    previewId: number;
    scrollPosition: PreviewScrollPosition;
    canGoBack?: boolean;
    canGoForward?: boolean;
    editable?: boolean;
    externalEditorLabel?: string;
    onBack?: () => void;
    onForward?: () => void;
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onValidateLocalFile?: (path: string) => Promise<boolean>;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onResolveProjectMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onResolveLocalMedia?: (path: string) => Promise<Attachment | undefined>;
    onSaveProjectFile?: (path: string, content: string) => Promise<boolean>;
    onOpenExternalEditor?: (path: string) => void;
    onScrollPositionChange?: (id: number, position: PreviewScrollPosition) => void;
    onDirtyChange?: (dirty: boolean) => void;
    onClose: () => void;
  } = $props();

  let contentScrollElement = $state<HTMLDivElement | undefined>();
  let wrapLines = $state(false);

  const title = $derived(file?.path ?? attachment?.name ?? "Preview");
  const source = $derived(
    attachment?.dataUrl ?? (attachment?.path ? convertFileSrc(attachment.path) : ""),
  );
  const language = $derived(file ? languageForFilePath(file.path) : undefined);
  const markdown = $derived(language === "markdown");
  const renderAsMarkdown = $derived(language === "markdown" && !lineRange);
  const highlighted = $derived(
    file && !renderAsMarkdown ? highlightCode(file.content, language) : undefined,
  );

  const editorController = createPreviewEditorController({
    previewId: () => previewId,
    file: () => file,
    editable: () => editable,
    onSaveProjectFile: () => onSaveProjectFile,
    onDirtyChange: () => onDirtyChange,
  });
  const editorState = editorController.state;
  const editing = $derived(editorState.editing);
  const saving = $derived(editorState.saving);
  const canEdit = $derived(editorController.canEdit);
  const dirty = $derived(editorController.dirty);

  const scrollController = createPreviewScrollController({
    previewId: () => previewId,
    scrollPosition: () => scrollPosition,
    lineRange: () => lineRange,
    file: () => file,
    highlighted: () => highlighted,
    element: () => contentScrollElement,
    editing: () => editorState.editing,
    onBack: () => onBack,
    onForward: () => onForward,
    onScrollPositionChange: () => onScrollPositionChange,
  });

  const markdownController = createPreviewMarkdownController({
    previewId: () => previewId,
    file: () => file,
    onValidateProjectFile: () => onValidateProjectFile,
    onOpenProjectFile: () => onOpenProjectFile,
    onOpenLocalFile: () => onOpenLocalFile,
    rememberScroll: scrollController.remember,
  });

  const restoreScroll = scrollController.restoreScroll;
  const rememberScroll = scrollController.remember;
  const handleBack = scrollController.back;
  const handleForward = scrollController.forward;
  const projectLinkPath = markdownController.projectLinkPath;
  const openProjectFromMarkdown = markdownController.openProject;
  const validateProjectFromMarkdown = markdownController.validateProject;
  const openLocalFromMarkdown = markdownController.openLocal;
  const saveEdit = editorController.save;
  const handleEditorKeydown = editorController.handleKeydown;
  function handleEditorCopy(event: ClipboardEvent): void {
    const editor = event.currentTarget;
    if (!(editor instanceof HTMLTextAreaElement) || !event.clipboardData) return;
    const start = editor.selectionStart ?? 0;
    const end = editor.selectionEnd ?? start;
    if (end <= start) return;
    event.clipboardData.setData("text/plain", editor.value.slice(start, end));
    event.preventDefault();
  }

  export function requestClose(): boolean {
    if (!editorController.canClose()) return false;
    onClose();
    return true;
  }

</script>

<section
  class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
  aria-label={`Preview ${title}`}
>
    <header class="flex min-h-9 min-w-0 items-center gap-2 border-b border-border bg-chrome px-3">
      <div class="flex shrink-0 items-center gap-0.5" aria-label="Preview history">
        <button
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground/35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/35"
          type="button"
          aria-label="Go back"
          title="Back"
          disabled={!canGoBack || editing}
          onclick={handleBack}
        >
          <ArrowLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground/35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/35"
          type="button"
          aria-label="Go forward"
          title="Forward"
          disabled={!canGoForward || editing}
          onclick={handleForward}
        >
          <ArrowRight class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {#if file}
        <FileCode class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <strong class="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</strong>
      {#if file && lineRange}
        <span class="shrink-0 rounded border border-tool-warning/30 bg-tool-warning/10 px-1.5 py-0.5 font-mono text-xs text-tool-warning">
          L{lineRange.startLine}{lineRange.endLine === lineRange.startLine ? "" : `–${lineRange.endLine}`}
        </span>
      {/if}
      {#if renderAsMarkdown}
        <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Markdown
        </span>
      {:else if highlighted}
        <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
      {#if canEdit}
        {#if editing}
          <button
            class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            disabled={saving}
            onclick={editorController.cancel}
          >Cancel</button>
          <button
            class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
            type="button"
            disabled={saving || !dirty}
            onclick={() => void saveEdit()}
          ><Check class="h-3.5 w-3.5" aria-hidden="true" />{saving ? "Saving…" : "Save"}</button>
        {:else}
          <button
            class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            onclick={editorController.begin}
          ><Pencil class="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
        {/if}
      {/if}
      {#if file && externalEditorLabel && onOpenExternalEditor}
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          type="button"
          title={`Open in ${externalEditorLabel}`}
          aria-label={`Open ${file.path} in ${externalEditorLabel}`}
          onclick={() => onOpenExternalEditor?.(file.path)}
        >
          <ExternalLink class="h-4 w-4" aria-hidden="true" />
        </button>
      {/if}
    </header>
    {#if file}
      {#if editing}
        <textarea
          class="min-h-0 min-w-0 flex-1 resize-none bg-background p-5 font-mono text-sm leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          bind:value={editorState.draft}
          aria-label={`Edit ${file.path}`}
          spellcheck="false"
          onkeydown={handleEditorKeydown}
          oncopy={handleEditorCopy}
        ></textarea>
      {:else if renderAsMarkdown}
        {#key previewId}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex Scrollable preview needs keyboard focus. -->
          <div
            bind:this={contentScrollElement}
            use:restoreScroll={{ key: previewId, position: scrollPosition }}
            class="preview-text-surface min-h-0 min-w-0 flex-1 overflow-auto bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                onValidateProjectFile={validateProjectFromMarkdown}
                {onValidateLocalFile}
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
          class="preview-text-surface min-h-0 min-w-0 flex-1 overflow-auto bg-code outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="region"
          aria-label={`Source for ${file.path}`}
          tabindex="0"
          onscroll={rememberScroll}
        >
          <pre class={wrapLines
            ? "m-0 min-h-full w-full min-w-0 py-3 font-mono text-xs leading-6 text-foreground"
            : "m-0 min-h-full min-w-full w-max py-3 font-mono text-xs leading-6 text-foreground"}><code
              class:wrap-lines={wrapLines}
              class="preview-code"
            >{@html highlighted.html}</code></pre>
        </div>
      {/if}
    {:else if attachment}
      <div class="grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden bg-background p-3">
        {#if attachment.kind === "image"}
          <img class="max-h-full max-w-full object-contain" src={source} alt={attachment.name} />
        {:else}
        <!-- svelte-ignore a11y_media_has_caption User-selected videos do not necessarily include a captions track. -->
          <video
            class="max-h-full max-w-full"
            src={source}
            controls
          ></video>
        {/if}
      </div>
    {/if}
</section>

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
    border-right: 1px solid var(--code-border);
    background: var(--panel);
    color: var(--muted-foreground);
    content: counter(preview-line);
    counter-increment: preview-line;
    font-variant-numeric: tabular-nums;
    text-align: right;
    padding-right: 0.75rem;
    text-indent: 0;
    user-select: none;
  }

  .preview-code :global(.sh__line.preview-range-highlight) {
    background: color-mix(in srgb, var(--tool-warning) 18%, transparent);
  }

  .preview-code :global(.sh__line.preview-range-highlight)::before {
    background: color-mix(in srgb, var(--tool-warning) 13%, var(--panel));
    color: var(--foreground);
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
