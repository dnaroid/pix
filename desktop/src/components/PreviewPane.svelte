<script lang="ts">
  import { iconButtonClass } from "../lib/icon-button";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Search from "@lucide/svelte/icons/search";
  import WrapText from "@lucide/svelte/icons/wrap-text";
  import X from "@lucide/svelte/icons/x";
  import { onDestroy } from "svelte";
  import type { Attachment } from "../lib/attachments";
  import { isGlbPath } from "../lib/glb";
  import { previewMediaKindForPath } from "../lib/media";
  import { copyPreviewFile, copyPreviewMedia, previewCopyFilePath } from "../lib/preview-media-copy";
  import { previewMediaPlayback } from "./audio-playback-action";
  import { audioSource } from "./audio-source-action";
  import { glbViewer } from "./glb-viewer-action";
  import "../styles/glb-viewer.css";
  import type { PreviewScrollPosition } from "../lib/preview-history";
  import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
  import { highlightCode, languageForFilePath } from "../lib/syntax-highlight";
  import MarkdownText from "./MarkdownText.svelte";
  import PreviewCopyButton from "./PreviewCopyButton.svelte";
  import { createPreviewEditorController } from "./preview-editor-controller.svelte";
  import { createPreviewFileSearchController } from "./preview-file-search-controller.svelte";
  import { createPreviewMarkdownController } from "./preview-markdown-controller.svelte";
  import { createPreviewScrollController } from "./preview-scroll-controller.svelte";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";
  import { openExternalHref } from "../lib/external-links";
  import { resolveWikiLink } from "../lib/project-wiki";
  import { normalizeProjectFileReference } from "../lib/markdown-links";

  let {
    attachment,
    file,
    workspace = "",
    markdownLinkBase,
    lineRange,
    searchRange,
    previewId,
    active = true,
    autoplay = false,
    onAutoplayConsumed = () => {},
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
    workspace?: string;
    markdownLinkBase?: "document";
    lineRange?: ProjectFileLineRange;
    searchRange?: ProjectFileLineRange;
    previewId: number;
    active?: boolean;
    autoplay?: boolean;
    onAutoplayConsumed?: () => void;
    scrollPosition: PreviewScrollPosition;
    canGoBack?: boolean;
    canGoForward?: boolean;
    editable?: boolean;
    externalEditorLabel?: string;
    onBack?: () => void;
    onForward?: () => void;
    onValidateProjectFile?: (path: string) => Promise<boolean | "directory">;
    onValidateLocalFile?: (path: string) => Promise<boolean | "directory">;
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
  let editorElement = $state<HTMLTextAreaElement | undefined>();
  let searchInputElement = $state<HTMLInputElement | undefined>();
  let wrapLines = $state(false);
  let audioError = $state(false);
  let previewImageElement = $state<HTMLImageElement | undefined>();
  let VisualEditor = $state<typeof import("./WikiMarkdownEditor.svelte").default>();
  let visualEditor = $state<{ readMarkdown: () => string; focus: () => void } | null>(null);
  let visualHost = $state<HTMLDivElement | undefined>();
  let editorMode = $state<"visual" | "source">("visual");
  let visualLoadError = $state<string | null>(null);
  const diagnostics = createDiagnosticLogger(() => ({ workspace }));

  async function copyMedia(isCurrent: () => boolean): Promise<void> {
    if (attachment) await copyPreviewMedia(attachment, previewImageElement, isCurrent);
  }

  const copyFilePath = $derived(file?.virtualWikiDirectory ? undefined : previewCopyFilePath(file?.path ?? attachment?.path, workspace));
  async function copyFile(isCurrent: () => boolean): Promise<void> {
    if (copyFilePath) await copyPreviewFile(copyFilePath, isCurrent);
  }

  $effect(() => { source; audioError = false; });

  const title = $derived(file?.virtualWikiDirectory ? `${file.virtualWikiDirectory}/ · Contents` : file?.path ?? attachment?.name ?? "Preview");
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
    editable: () => editable && !file?.virtualWikiDirectory,
    onSaveProjectFile: () => onSaveProjectFile,
    onDirtyChange: () => onDirtyChange,
  });
  const editorState = editorController.state;
  const editing = $derived(editorState.editing);
  const saving = $derived(editorState.saving);
  const canEdit = $derived(editorController.canEdit);
  const dirty = $derived(editorController.dirty);
  const visualEditing = $derived(editing && markdown && editorMode === "visual");

  $effect(() => {
    if (!visualEditing || VisualEditor) return;
    const sourceId = previewId;
    let current = true;
    void import("./WikiMarkdownEditor.svelte").then((module) => {
      if (current && previewId === sourceId) {
        visualLoadError = null;
        VisualEditor = module.default;
      }
    }).catch((error) => {
      diagnostics.report(error, "wiki:editor-load-failed");
      if (current && previewId === sourceId) visualLoadError = "The visual editor could not load. You can edit the Markdown source.";
    });
    return () => { current = false; };
  });

  const searchController = createPreviewFileSearchController({
    active: () => active,
    previewId: () => previewId,
    enabled: () => Boolean(file),
    editing: () => editing && !visualEditing,
    fileText: () => editing ? editorState.draft : (file?.content ?? ""),
    contentElement: () => visualEditing ? visualHost?.querySelector<HTMLElement>(".ProseMirror") ?? undefined : contentScrollElement,
    editorElement: () => editorElement,
    inputElement: () => searchInputElement,
  });
  const searchState = searchController.state;
  onDestroy(searchController.dispose);

  const scrollController = createPreviewScrollController({
    previewId: () => previewId,
    scrollPosition: () => scrollPosition,
    lineRange: () => lineRange,
    searchRange: () => searchRange,
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
    preferDocumentRelative: () => markdownLinkBase === "document",
  });

  const restoreScroll = scrollController.restoreScroll;
  const rememberScroll = scrollController.remember;
  const handleBack = scrollController.back;
  const handleForward = scrollController.forward;
  const projectLinkPath = markdownController.projectLinkPath;
  const openProjectFromMarkdown = markdownController.openProject;
  const validateProjectFromMarkdown = markdownController.validateProject;
  const openLocalFromMarkdown = markdownController.openLocal;
  async function saveEdit(): Promise<void> {
    if (visualEditing && visualEditor) editorState.draft = visualEditor.readMarkdown();
    await editorController.save();
  }
  function beginEdit(): void {
    editorMode = renderAsMarkdown ? "visual" : "source";
    visualLoadError = null;
    editorController.begin();
  }
  function switchEditorMode(mode: "visual" | "source"): void {
    if (visualEditing && visualEditor) editorState.draft = visualEditor.readMarkdown();
    editorMode = mode;
  }
  async function resolveEditorImage(source: string): Promise<string | undefined> {
    if (/^https?:\/\//iu.test(source)) return source;
    const path = file && resolveWikiLink(file.path, source);
    if (!path) return undefined;
    const media = await onResolveProjectMedia?.(path);
    return media?.dataUrl ?? (media?.path ? convertFileSrc(media.path) : undefined);
  }
  async function openEditorLink(href: string): Promise<void> {
    if (/^(?:https?:\/\/|mailto:)/iu.test(href)) { await openExternalHref(href); return; }
    if (!file) return;
    const reference = normalizeProjectFileReference(href, markdownLinkBase === "document" ? file.path : undefined);
    if (!reference) return;
    if (markdownLinkBase === "document") await onOpenProjectFile?.(reference.path, reference.range);
    else await openProjectFromMarkdown(reference.path, reference.range);
  }
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

  let closePending = false;
  export async function requestClose(): Promise<boolean> {
    if (closePending) return false;
    closePending = true;
    try {
      const requestedPreviewId = previewId;
      if (!await editorController.canClose() || previewId !== requestedPreviewId) return false;
      onClose();
      return true;
    } finally {
      closePending = false;
    }
  }

</script>

<svelte:window onkeydown={searchController.handleWindowKeydown} />

<section
  class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
  aria-label={`Preview ${title}`}
  data-context-file-path={file?.path ?? attachment?.path ?? ""}
>
    <header class="flex min-h-9 min-w-0 items-center gap-2 border-b border-border bg-chrome px-3">
      <div class="flex shrink-0 items-center gap-0.5" aria-label="Preview history">
        <button
          class={iconButtonClass("md", "popover")}
          type="button"
          aria-label="Go back"
          title="Back"
          disabled={!canGoBack || editing}
          onclick={handleBack}
        >
          <ArrowLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          class={iconButtonClass("md", "popover")}
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
      <strong class="select-text min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</strong>
      {#if file && lineRange}
        <span class="shrink-0 rounded border border-tool-warning/30 bg-tool-warning/10 px-1.5 py-0.5 font-mono text-xs text-tool-warning">
          L{lineRange.startLine}{lineRange.endLine === lineRange.startLine ? "" : `–${lineRange.endLine}`}
        </span>
      {/if}
      {#if file}
        <PreviewCopyButton text={editing ? editorState.draft : file.content} {previewId} />
        <button
          class={searchState.open
            ? "grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            : "grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"}
          type="button"
          aria-label="Find in file"
          aria-pressed={searchState.open}
          title="Find in file (Ctrl/⌘F)"
          onclick={searchController.open}
        ><Search class="h-4 w-4" aria-hidden="true" /></button>
      {/if}
      {#if !file && attachment?.kind === "image"}
        <PreviewCopyButton
          text={source}
          {previewId}
          label="Copy image"
          onCopy={copyMedia}
        />
      {/if}
      {#if (file && !file.virtualWikiDirectory) || attachment}
        <PreviewCopyButton
          text={copyFilePath ?? ""}
          {previewId}
          label="Copy file"
          fileCopy
          disabled={!copyFilePath}
          onCopy={copyFile}
        />
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
            onclick={beginEdit}
          ><Pencil class="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
        {/if}
      {/if}
      {#if file && externalEditorLabel && onOpenExternalEditor}
        <button
          class={iconButtonClass("md", "popover")}
          type="button"
          title={`Open in ${externalEditorLabel}`}
          aria-label={`Open ${file.path} in ${externalEditorLabel}`}
          onclick={() => onOpenExternalEditor?.(file.path)}
        >
          <ExternalLink class="h-4 w-4" aria-hidden="true" />
        </button>
      {/if}
    </header>
    {#if file && searchState.open}
      <div
        class="absolute top-11 right-3 z-30 flex h-8 max-w-[min(520px,calc(100%-24px))] items-center gap-1 rounded-md border border-border bg-popover px-1.5 text-popover-foreground shadow-md"
        data-preview-file-search
        role="search"
      >
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          bind:this={searchInputElement}
          class="h-6 min-w-[140px] flex-1 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          type="search"
          value={searchState.query}
          placeholder="Find in file"
          aria-label="Find in file"
          autocomplete="off"
          spellcheck="false"
          oninput={(event) => searchController.setQuery(event.currentTarget.value)}
          onkeydown={searchController.handleInputKeydown}
        />
        <span class="min-w-12 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">
          {searchState.query.trim()
            ? searchState.matchCount > 0
              ? `${searchState.activeIndex + 1}/${searchState.matchCount}`
              : "0/0"
            : ""}
        </span>
        <button
          class={iconButtonClass("sm", "popover")}
          type="button"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={searchState.matchCount === 0}
          onclick={searchController.previous}
        ><ChevronUp class="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button
          class={iconButtonClass("sm", "popover")}
          type="button"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={searchState.matchCount === 0}
          onclick={searchController.next}
        ><ChevronDown class="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button
          class={iconButtonClass("sm", "popover")}
          type="button"
          aria-label="Close find"
          title="Close find"
          onclick={searchController.close}
        ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>
    {/if}
    {#if file}
      {#if editing}
        {#if markdown}
          <div class="flex shrink-0 items-center gap-1 border-b border-border bg-chrome px-3 py-1 text-xs" role="group" aria-label="Markdown edit mode">
            <button type="button" class={["rounded-sm px-2 py-1 hover:bg-panel-hover", editorMode === "visual" ? "bg-panel-selected text-foreground" : "text-muted-foreground"]} aria-pressed={editorMode === "visual"} onclick={() => switchEditorMode("visual")}>Visual</button>
            <button type="button" class={["rounded-sm px-2 py-1 hover:bg-panel-hover", editorMode === "source" ? "bg-panel-selected text-foreground" : "text-muted-foreground"]} aria-pressed={editorMode === "source"} onclick={() => switchEditorMode("source")}>Source</button>
            <span class="ml-auto text-muted-foreground">Markdown · ⌘S to save</span>
          </div>
        {/if}
        {#if visualEditing}
          <div bind:this={visualHost} class="min-h-0 min-w-0 flex-1 overflow-hidden">
            {#if visualLoadError}
              <p class="p-4 text-sm text-tool-error" role="alert">{visualLoadError}</p>
            {:else if VisualEditor}
              {#key previewId}
                <VisualEditor
                  bind:this={visualEditor}
                  value={editorState.draft}
                  documentPath={file.path}
                  {workspace}
                  onChange={(value) => { editorState.draft = value; }}
                  onSave={() => void saveEdit()}
                  onResolveImage={resolveEditorImage}
                  onOpenLink={openEditorLink}
                  onSourceRequested={() => switchEditorMode("source")}
                />
              {/key}
            {:else}<p class="p-4 text-sm text-muted-foreground" role="status">Loading visual editor…</p>{/if}
          </div>
        {:else}
        <textarea
          bind:this={editorElement}
          class="preview-editor min-h-0 min-w-0 flex-1 resize-none bg-background p-5 font-mono text-sm leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          bind:value={editorState.draft}
          aria-label={`Edit ${file.path}`}
          spellcheck="false"
          onkeydown={handleEditorKeydown}
          oncopy={handleEditorCopy}
        ></textarea>
        {/if}
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
            <div class="preview-markdown-content mx-auto w-[calc(100%-4rem)] max-w-[776px] py-6 text-sm leading-6">
              <MarkdownText
                text={file.content}
                documentPath={markdownLinkBase === "document" ? file.path : undefined}
                fitTables
                remoteImages
                headingAnchors
                sourceLineRanges={Boolean(searchRange)}
                onValidateProjectFile={markdownLinkBase === "document" ? onValidateProjectFile : validateProjectFromMarkdown}
                {onValidateLocalFile}
                onOpenProjectFile={markdownLinkBase === "document" ? onOpenProjectFile : openProjectFromMarkdown}
                onResolveProjectMedia={(path) => onResolveProjectMedia?.(markdownLinkBase === "document" ? path : projectLinkPath(path)) ?? Promise.resolve(undefined)}
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
          data-preview-source-path={file.path}
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
      <div class="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden bg-background p-3">
        {#if isGlbPath(attachment.path ?? attachment.name)}
          <div class="glb-preview" use:glbViewer={source}></div>
        {:else if attachment.kind === "image"}
          <img bind:this={previewImageElement} class="size-full min-h-0 min-w-0 object-contain" src={source} alt={attachment.name} data-image-path={attachment.path} />
        {:else if previewMediaKindForPath(attachment.path ?? attachment.name) === "audio"}
          {#key previewId}
            <div class="flex w-full max-w-lg flex-col gap-3 text-sm text-muted-foreground">
              <span class="break-words">{attachment.name}</span>
              <audio
                class="w-full [color-scheme:light_dark]"
                data-context-file-path={attachment.path ?? ""}
                aria-label={attachment.name}
                controls
                preload="metadata"
                use:audioSource={{ source, path: attachment.path ?? attachment.name, active, autoplay, onAutoplayConsumed,
                  onUnavailable: () => { audioError = true; } }}
              ></audio>
              {#if audioError}
                <p role="status">Audio unavailable. The file may be damaged or its codec unsupported.</p>
              {/if}
            </div>
          {/key}
        {:else}
        {#key previewId}
        <!-- svelte-ignore a11y_media_has_caption User-selected videos do not necessarily include a captions track. -->
          <video
            class="size-full min-h-0 min-w-0 object-contain"
            data-context-file-path={attachment.path ?? ""}
            src={source}
            controls
            use:previewMediaPlayback={{ active, autoplay, onAutoplayConsumed }}
          ></video>
        {/key}
        {/if}
      </div>
    {/if}
</section>

<style>
  .preview-markdown-content :global(.preview-range-highlight) {
    background: color-mix(in srgb, var(--tool-warning) 18%, transparent);
    outline: 1px solid color-mix(in srgb, var(--tool-warning) 45%, transparent);
    outline-offset: 3px;
    border-radius: 2px;
  }
  /* Bound WebKit's selection-gap paint to the text column, not its gutters. */
  .preview-markdown-content {
    contain: paint;
  }

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

  :global(::highlight(pix-preview-search)) {
    background: color-mix(in srgb, var(--tool-warning) 28%, transparent);
  }

  :global(::highlight(pix-preview-search-active)) {
    background: color-mix(in srgb, var(--tool-warning) 55%, transparent);
  }
</style>
