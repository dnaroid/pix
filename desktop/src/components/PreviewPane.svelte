<script lang="ts">
  import { iconButtonClass } from "../lib/icon-button";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Languages from "@lucide/svelte/icons/languages";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
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
  import type { ProjectFileLineRange, ProjectFilePreview, ProjectFileSaveGuard } from "../lib/project-files";
  import { highlightCode, languageForFilePath } from "../lib/syntax-highlight";
  import MarkdownText from "./MarkdownText.svelte";
  import PreviewCopyButton from "./PreviewCopyButton.svelte";
  import WikiConsistencyReport from "./WikiConsistencyReport.svelte";
  import type { KnowledgeCheckResult, KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import { knowledgeEvidenceText } from "../lib/knowledge-citation";
  import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";
  import { stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
  import { createPreviewEditorController } from "./preview-editor-controller.svelte";
  import { createPreviewFileSearchController } from "./preview-file-search-controller.svelte";
  import { createPreviewMarkdownController } from "./preview-markdown-controller.svelte";
  import { createPreviewScrollController } from "./preview-scroll-controller.svelte";
  import { createPreviewEvidenceController } from "./preview-evidence-controller.svelte";
  import { createPreviewTranslationController, type PreviewDocumentTranslator } from "./preview-translation-controller.svelte";
  import { createPreviewAnnotationController, type PreviewFileAnnotator } from "./preview-annotation-controller.svelte";
  import { insertPreviewAnnotations, type PreviewAnnotationHeader } from "../lib/preview-annotations";
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
    evidenceCitation,
    evidenceLanguage,
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
    onOpenKnowledgeCitation,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
    onSaveProjectFile,
    onCheckKnowledge,
    knowledgeJobs = [],
    onEnqueueKnowledgeCheck,
    onCancelKnowledgeCheck,
    knowledgeCheckEnabled = true,
    onResolveKnowledge,
    knowledgeResolving = false,
    onOpenExternalEditor,
    onAnnotateFile,
    onTranslateDocument,
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
    evidenceCitation?: KnowledgeCitation;
    evidenceLanguage?: KnowledgeReportLanguage;
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
    onOpenKnowledgeCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onResolveProjectMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onResolveLocalMedia?: (path: string) => Promise<Attachment | undefined>;
    onSaveProjectFile?: (path: string, content: string, guard?: ProjectFileSaveGuard) => Promise<boolean>;
    onCheckKnowledge?: (path: string, content: string, signal: AbortSignal) => Promise<KnowledgeCheckResult | undefined>;
    knowledgeJobs?: readonly ProjectKnowledgeJob[];
    onEnqueueKnowledgeCheck?: (input: ManualKnowledgeCheckInput) => number | undefined;
    onCancelKnowledgeCheck?: (id: number) => void;
    knowledgeCheckEnabled?: boolean;
    onResolveKnowledge?: (result: KnowledgeCheckResult, snapshot: string) => void | Promise<void>;
    knowledgeResolving?: boolean;
    onOpenExternalEditor?: (path: string) => void;
    /** Inline commentary rendered as highlighted insertions in the source. */
    onAnnotateFile?: PreviewFileAnnotator;
    /** Whole-document Markdown translation with a project cache. */
    onTranslateDocument?: PreviewDocumentTranslator;
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
  const previewContent = $derived(file ? markdown && !file.virtualWikiDirectory ? stripKnowledgeCheckStamp(file.content) : file.content : "");
  const canCheckKnowledge = $derived(markdown && !file?.virtualWikiDirectory && knowledgeCheckEnabled && Boolean(onEnqueueKnowledgeCheck || onCheckKnowledge));
  const highlighted = $derived(
    file && !renderAsMarkdown ? highlightCode(previewContent, language) : undefined,
  );

  const translation = createPreviewTranslationController({
    translate: () => onTranslateDocument,
    onError: (error) => diagnostics.warn("preview:document-translation-failed", error),
  });
  onDestroy(translation.dispose);
  $effect(() => { translation.setSource(`${previewId}\0${file?.path ?? ""}\0${renderAsMarkdown ? previewContent : ""}`); });
  const translationState = translation.state;
  const canTranslate = $derived(Boolean(file && renderAsMarkdown && !file.virtualWikiDirectory && onTranslateDocument && previewContent.trim()));
  const showingTranslation = $derived(canTranslate && translationState.showing);
  const renderedMarkdown = $derived(showingTranslation ? translationState.text : previewContent);
  const translationSummary = $derived.by(() => {
    if (translationState.status === "error") return translationState.error || "Translation failed";
    if (translation.running) return translationState.text ? "Translating…" : "Preparing translation…";
    if (translationState.status !== "done") return "";
    const target = translationState.language ? ` · ${translationState.language}` : "";
    if (translationState.chunks === 0) return `Nothing to translate${target}`;
    if (translationState.cachedChunks === translationState.chunks) return `Translation${target} · from cache`;
    if (translationState.cachedChunks > 0) return `Translation${target} · ${translationState.cachedChunks}/${translationState.chunks} sections from cache`;
    return `Translation${target}`;
  });

  const annotations = createPreviewAnnotationController({
    annotate: () => onAnnotateFile,
    onError: (error) => diagnostics.warn("preview:file-annotation-failed", error),
  });
  onDestroy(annotations.dispose);
  $effect(() => { annotations.setSource(`${file?.path ?? ""}\0${highlighted ? previewContent : ""}`); });
  const annotationState = annotations.state;
  const canAnnotate = $derived(Boolean(file && highlighted && !file.virtualWikiDirectory && onAnnotateFile && previewContent.trim()));
  const showingAnnotations = $derived(canAnnotate && annotationState.showing);
  const annotationHeader = $derived.by((): PreviewAnnotationHeader | undefined => {
    const russian = annotationState.language === "ru";
    const loading = annotationState.status === "loading";
    const partsProgress = annotationState.totalParts > 1 ? ` ${annotationState.completedParts}/${annotationState.totalParts}` : "";
    if (annotationState.status === "error") {
      const reason = (annotationState.error || "The explanation is unavailable").trim().replace(/^File annotation failed:\s*/u, "");
      return { kind: "error", label: "Explain failed", text: `${/[.!?…]$/u.test(reason) ? reason : `${reason}.`} Click Explain to retry.` };
    }
    if (loading && !annotationState.summary) return { kind: "status", text: `Explaining the file…${partsProgress}` };
    if (!annotationState.summary) {
      return !loading && annotationState.failedParts > 0
        ? { kind: "status", text: `${annotationState.failedParts} part(s) could not be explained. Shift+click Explain to retry.` }
        : undefined;
    }
    const notes: string[] = [];
    if (loading) notes.push(`Explaining…${partsProgress}`);
    if (!loading && annotationState.failedParts > 0) {
      notes.push(russian
        ? `Не удалось прокомментировать частей: ${annotationState.failedParts}. Shift+клик по Explain повторит.`
        : `${annotationState.failedParts} part(s) could not be explained. Shift+click Explain to retry.`);
    }
    if (!loading && annotationState.annotatedLines < annotationState.totalLines) {
      notes.push(russian
        ? `Прокомментированы первые ${annotationState.annotatedLines} из ${annotationState.totalLines} строк.`
        : `Comments cover the first ${annotationState.annotatedLines} of ${annotationState.totalLines} lines.`);
    }
    return { kind: "summary", label: russian ? "О модуле" : "About this module", text: [annotationState.summary, ...notes].join("\n\n") };
  });
  const sourceHtml = $derived(highlighted
    ? showingAnnotations ? insertPreviewAnnotations(highlighted.html, annotationState.status === "error" ? [] : annotationState.annotations, annotationHeader) : highlighted.html
    : "");
  function handleExplainClick(event: MouseEvent): void {
    if (!file) return;
    if (annotations.running) { annotations.cancel(); return; }
    // Shift+click ignores the cached explanation and asks the model again.
    if (event.shiftKey) { void annotations.annotate(file.path, previewContent, true); return; }
    annotations.toggle(file.path, previewContent);
  }

  const editorController = createPreviewEditorController({
    previewId: () => previewId,
    file: () => file,
    editable: () => editable && !file?.virtualWikiDirectory,
    workspace: () => workspace,
    onSaveProjectFile: () => onSaveProjectFile,
    onCheckKnowledge: () => onCheckKnowledge,
    knowledgeJobs: () => knowledgeJobs,
    onEnqueueKnowledgeCheck: () => onEnqueueKnowledgeCheck,
    onCancelKnowledgeCheck: () => onCancelKnowledgeCheck,
    onKnowledgeCheckError: (error) => diagnostics.warn("wiki:consistency-check-failed", error),
    onDirtyChange: () => onDirtyChange,
  });
  const editorState = editorController.state;
  const editing = $derived(editorState.editing);
  const saving = $derived(editorState.saving);
  const checking = $derived(editorController.checking);
  const queued = $derived(editorController.queued);
  const knowledgeResult = $derived(editorController.knowledgeResult);
  const knowledgeReportStale = $derived(editorController.knowledgeReportStale);
  const knowledgeReportCheckedAt = $derived(editorController.knowledgeReportCheckedAt);
  const knowledgeRecordingError = $derived(editorController.knowledgeRecordingError);
  const canEdit = $derived(editorController.canEdit);
  const dirty = $derived(editorController.dirty);
  const savedKnowledgeStamp = $derived(knowledgeCheckEnabled && markdown && !file?.virtualWikiDirectory ? editorController.savedKnowledgeStamp : undefined);
  const knowledgeRussian = $derived((knowledgeResult?.reportLanguage ?? savedKnowledgeStamp?.reportLanguage ?? evidenceLanguage) === "ru");
  const savedCheckTitle = $derived(savedKnowledgeStamp
    ? `${savedKnowledgeStamp.reportLanguage === "ru" ? "В проверенных фрагментах противоречий не найдено" : "No contradictions found in the reviewed passages"} · ${savedKnowledgeStamp.checkedAt} · ${savedKnowledgeStamp.modelRef}` : "");
  const visualEditing = $derived(editing && markdown && editorMode === "visual");
  onDestroy(editorController.dispose);

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
      diagnostics.warn("wiki:editor-load-failed", error);
      if (current && previewId === sourceId) visualLoadError = "The visual editor could not load. You can edit the Markdown source.";
    });
    return () => { current = false; };
  });

  const searchController = createPreviewFileSearchController({
    active: () => active,
    previewId: () => previewId,
    enabled: () => Boolean(file),
    editing: () => editing && !visualEditing,
    fileText: () => editing ? editorState.draft : renderedMarkdown,
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

  const evidenceController = createPreviewEvidenceController({
    previewId: () => previewId,
    workspace: () => workspace,
    active: () => active,
    citation: () => evidenceCitation,
    file: () => file,
    content: () => previewContent,
    element: () => contentScrollElement,
    editing: () => editing,
    scrollPosition: () => scrollPosition,
    onError: (error) => diagnostics.warn("wiki:evidence-highlight-failed", error),
  });
  onDestroy(evidenceController.dispose);

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
    if (visualEditing && visualEditor) editorController.updateDraft(visualEditor.readMarkdown());
    await editorController.save();
  }
  async function checkEdit(): Promise<void> {
    if (visualEditing && visualEditor) editorController.updateDraft(visualEditor.readMarkdown());
    await editorController.check();
  }
  async function saveEditAnyway(): Promise<void> {
    if (visualEditing && visualEditor) editorController.updateDraft(visualEditor.readMarkdown());
    await editorController.saveAnyway();
  }
  async function resolveKnowledge(): Promise<void> {
    const result = knowledgeResult;
    if (!result || knowledgeReportStale || !/^[0-9a-f]{64}$/u.test(result.documentHash)) return;
    const snapshot = editing
      ? visualEditing && visualEditor ? visualEditor.readMarkdown() : editorState.draft
      : previewContent;
    await onResolveKnowledge?.(result, snapshot);
  }
  function beginEdit(): void {
    translation.showOriginal();
    annotations.hide();
    editorMode = renderAsMarkdown ? "visual" : "source";
    visualLoadError = null;
    editorController.begin();
  }
  function switchEditorMode(mode: "visual" | "source"): void {
    if (visualEditing && visualEditor) editorController.updateDraft(visualEditor.readMarkdown());
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
      <strong class={["select-text min-w-0 flex-1 truncate text-xs font-medium", savedKnowledgeStamp ? "text-tool-success" : ""]} title={title}>{title}</strong>
      {#if savedKnowledgeStamp}
        <span class="inline-flex shrink-0 items-center gap-1 rounded border border-tool-success/30 bg-tool-success/10 px-1.5 py-0.5 text-xs text-tool-success" title={savedCheckTitle} aria-label={savedCheckTitle}>
          <Check class="h-3.5 w-3.5" aria-hidden="true" />{savedKnowledgeStamp.reportLanguage === "ru" ? "Проверено" : "Checked"}
        </span>
      {/if}
      {#if file && lineRange}
        <span class="shrink-0 rounded border border-tool-warning/30 bg-tool-warning/10 px-1.5 py-0.5 font-mono text-xs text-tool-warning">
          L{lineRange.startLine}{lineRange.endLine === lineRange.startLine ? "" : `–${lineRange.endLine}`}
        </span>
      {/if}
      {#if file}
        <PreviewCopyButton text={editing ? editorState.draft : previewContent} {previewId} />
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
      {#if canAnnotate && !editing}
        <button
          class={["inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            showingAnnotations ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"]}
          type="button"
          aria-pressed={showingAnnotations}
          aria-busy={annotations.running}
          title={annotations.running ? "Cancel the explanation" : showingAnnotations ? "Hide the explanation (Shift+click to explain again)" : "Explain this file inline (Shift+click ignores the cache)"}
          onclick={handleExplainClick}
        ><MessageSquareText class={["h-3.5 w-3.5", annotations.running ? "animate-pulse" : ""]} aria-hidden="true" />{annotations.running ? "Explaining…" : "Explain"}</button>
      {/if}
      {#if canTranslate && !editing}
        <button
          class={["inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            showingTranslation ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"]}
          type="button"
          aria-pressed={showingTranslation}
          title={showingTranslation ? "Show the original document" : "Translate this document (cached in .pi/translations)"}
          onclick={() => file && translation.toggle(file.path, previewContent)}
        ><Languages class="h-3.5 w-3.5" aria-hidden="true" />{showingTranslation ? "Original" : "Translate"}</button>
      {/if}
      {#if canCheckKnowledge}
        <button
          class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
          type="button"
          disabled={saving || checking}
          title={knowledgeRussian ? "Проверить документ на противоречия с Wiki проекта" : "Check this document for contradictions with the project Wiki"}
          onclick={() => void checkEdit()}
        >{queued ? knowledgeRussian ? "В очереди…" : "Queued…" : checking ? knowledgeRussian ? "Проверяем…" : "Checking…" : knowledgeRussian ? "Проверить противоречия" : "Check consistency"}</button>
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
            disabled={saving || checking || !dirty}
            onclick={() => void saveEdit()}
          ><Check class="h-3.5 w-3.5" aria-hidden="true" />{checking ? "Checking…" : saving ? "Saving…" : "Save"}</button>
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
    {#if showingTranslation && !editing}
      <div class="flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-1 text-xs" data-preview-translation>
        <Languages class={["h-3.5 w-3.5 shrink-0", translationState.status === "error" ? "text-tool-error" : "text-muted-foreground"]} aria-hidden="true" />
        <span class={["min-w-0 flex-1 truncate", translationState.status === "error" ? "text-tool-error" : "text-muted-foreground"]} role="status" title={translationSummary}>{translationSummary}</span>
        {#if translation.running}
          <button type="button" class="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-panel-hover hover:text-foreground" onclick={translation.cancel}>Cancel</button>
        {:else if file}
          <button
            type="button"
            class="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-panel-hover hover:text-foreground"
            title="Translate again, ignoring cached sections"
            onclick={() => file && void translation.translate(file.path, previewContent, true)}
          >{translationState.status === "error" ? "Retry" : "Retranslate"}</button>
        {/if}
        <button type="button" class="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-panel-hover hover:text-foreground" onclick={translation.showOriginal}>Original</button>
      </div>
    {/if}
    {#if checking || knowledgeResult}
      <WikiConsistencyReport
        {checking}
        {queued}
        result={knowledgeResult}
        stale={knowledgeReportStale}
        checkedAt={knowledgeReportCheckedAt}
        canSaveAnyway={editorController.canSaveAnyway}
        canOpenSources={!dirty}
        onRetry={() => void checkEdit()}
        onCancel={editorController.cancelCheck}
        onSaveAnyway={() => void saveEditAnyway()}
        onOpenSource={onOpenProjectFile}
        onOpenCitation={onOpenKnowledgeCitation}
        onResolve={onResolveKnowledge ? resolveKnowledge : undefined}
        resolving={knowledgeResolving}
      />
    {/if}
    {#if knowledgeRecordingError}
      <p class="shrink-0 border-b border-border px-3 py-2 text-xs text-tool-warning" role="status">{knowledgeRecordingError}</p>
    {/if}
    {#if evidenceCitation && evidenceController.status !== "idle"}
      <div class="shrink-0 border-b border-border bg-panel px-3 py-2 text-xs" data-preview-evidence>
        <p class={evidenceController.status === "exact" ? "text-muted-foreground" : "text-tool-warning"} role="status">
          {knowledgeEvidenceText(evidenceController.status, evidenceLanguage)}
        </p>
        {#if evidenceController.status !== "exact"}
          <details class="group mt-1">
            <summary class="flex cursor-pointer list-none items-center gap-1.5 py-1 text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              {evidenceLanguage === "ru" ? "Цитата из отчёта" : "Quotation from the report"}
            </summary>
            <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-xs text-foreground">{evidenceCitation.quote}</pre>
          </details>
        {/if}
      </div>
    {/if}
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
                  onChange={editorController.updateDraft}
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
          value={editorState.draft}
          oninput={(event) => editorController.updateDraft(event.currentTarget.value)}
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
            <div class="preview-markdown-content mx-auto w-[calc(100%-4rem)] max-w-[776px] py-6 text-sm leading-6" lang={showingTranslation ? translationState.language || undefined : undefined}>
              {#if showingTranslation && !translationState.text}
                <p class="text-muted-foreground" role="status">{translationState.status === "error" ? "The translation is unavailable." : "Translating…"}</p>
              {/if}
              <MarkdownText
                text={renderedMarkdown}
                documentPath={markdownLinkBase === "document" ? file.path : undefined}
                fitTables
                remoteImages
                headingAnchors
                sourceLineRanges={!showingTranslation && Boolean(searchRange || evidenceCitation)}
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
          class="preview-text-surface preview-source-surface min-h-0 min-w-0 flex-1 overflow-auto outline-none [container-type:inline-size] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="region"
          aria-label={`Source for ${file.path}`}
          data-preview-source-path={file.path}
          tabindex="0"
          onscroll={rememberScroll}
        >
          <pre class={wrapLines
            ? "preview-source m-0 min-h-full w-full min-w-0 py-4 font-mono text-foreground"
            : "preview-source m-0 min-h-full min-w-full w-max py-4 font-mono text-foreground"}><code
              class:wrap-lines={wrapLines}
              class="preview-code"
            >{@html sourceHtml}</code></pre>
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
  .preview-markdown-content :global(.preview-evidence-section) {
    background: color-mix(in srgb, var(--tool-warning) 14%, transparent);
    outline: 1px dashed color-mix(in srgb, var(--tool-warning) 65%, transparent);
    outline-offset: 3px;
    border-radius: 2px;
  }
  :global(::highlight(pix-preview-evidence)) {
    background: color-mix(in srgb, var(--tool-warning) 42%, transparent);
    text-decoration: underline;
    text-decoration-color: var(--tool-warning);
  }
  /* Bound WebKit's selection-gap paint to the text column, not its gutters. */
  .preview-markdown-content {
    contain: paint;
  }

  /*
   * Source reading typography: 13px Geist Mono with an airy 1.7 rhythm,
   * contextual alternates on, no decorative ligatures, crisp glyphs on dark.
   */
  .preview-source-surface {
    background: var(--source-surface);
    color: var(--sh-identifier);
  }

  .preview-source {
    font-size: 13px;
    line-height: 1.7;
    font-feature-settings: "calt" 1, "liga" 0;
    font-variant-ligatures: contextual;
    letter-spacing: -0.003em;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
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
    min-height: 1.7em;
    min-width: 100%;
    width: max-content;
    padding-right: 1.5rem;
    white-space: pre;
  }

  .preview-code :global(.sh__line:hover) {
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
  }

  .preview-code :global(.sh__token--keyword) {
    font-weight: 500;
  }

  /* Quiet gutter on the code surface itself: numbers recede until hovered. */
  .preview-code :global(.sh__line)::before {
    position: sticky;
    left: 0;
    display: inline-block;
    width: 3.5rem;
    margin-right: 1.25rem;
    border-right: 1px solid var(--source-gutter-border);
    background: var(--source-surface);
    color: var(--source-gutter);
    content: counter(preview-line);
    counter-increment: preview-line;
    font-size: 12px;
    font-style: normal;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    text-align: right;
    padding-right: 0.875rem;
    text-indent: 0;
    user-select: none;
  }

  .preview-code :global(.sh__line:hover)::before {
    background: color-mix(in srgb, var(--foreground) 4%, var(--source-surface));
    color: var(--foreground);
  }

  /*
   * Inline comment rows: a highlighted insertion aligned with the code column,
   * sticky to the left edge while scrolling horizontally, never selected or
   * copied with the source, and without a line number.
   */
  .preview-code :global(.preview-annotation) {
    position: sticky;
    left: 0;
    display: block;
    width: min(100%, 52rem);
    max-width: calc(100cqw - 1rem);
    padding: 0.3rem 1rem 0.35rem 4.75rem;
    white-space: normal;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  .preview-code :global(.preview-annotation-body) {
    display: block;
    border-left: 2px solid var(--annotation-accent);
    border-radius: 0 6px 6px 0;
    background: var(--annotation-surface);
    color: var(--annotation-foreground);
    padding: 0.35rem 0.75rem;
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-style: normal;
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: 0;
  }

  .preview-code :global(.preview-annotation-body code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    padding: 0.02rem 0.28rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--annotation-accent) 14%, transparent);
    color: var(--annotation-code);
  }

  .preview-code :global(.preview-annotation-body strong) { font-weight: 600; }

  /* Module summary before line 1, plus progress and failure rows in the same place. */
  .preview-code :global(.preview-annotation-summary),
  .preview-code :global(.preview-annotation-status),
  .preview-code :global(.preview-annotation-error) {
    padding-top: 0.25rem;
    padding-bottom: 0.75rem;
  }

  .preview-code :global(.preview-annotation-summary .preview-annotation-body) {
    border-left-width: 3px;
    padding: 0.55rem 0.85rem;
    font-size: 13px;
  }

  .preview-code :global(.preview-annotation-label) {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--annotation-accent);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .preview-code :global(.preview-annotation-paragraph) { display: block; }
  .preview-code :global(.preview-annotation-paragraph + .preview-annotation-paragraph) { margin-top: 0.4rem; }

  .preview-code :global(.preview-annotation-status .preview-annotation-body) {
    border-left-color: var(--source-gutter-border);
    background: transparent;
    color: var(--muted-foreground);
    font-style: italic;
  }

  .preview-code :global(.preview-annotation-error .preview-annotation-body) {
    border-left-color: var(--tool-error);
    background: color-mix(in srgb, var(--tool-error) 9%, var(--source-surface));
  }

  .preview-code :global(.preview-annotation-error .preview-annotation-label) { color: var(--tool-error); }

  .preview-code :global(.sh__line.preview-range-highlight) {
    background: color-mix(in srgb, var(--tool-warning) 18%, transparent);
  }

  .preview-code :global(.sh__line.preview-range-highlight)::before {
    background: color-mix(in srgb, var(--tool-warning) 13%, var(--source-surface));
    color: var(--foreground);
  }

  .preview-code.wrap-lines :global(.sh__line) {
    position: relative;
    min-width: 0;
    width: 100%;
    padding-left: 4.75rem;
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
