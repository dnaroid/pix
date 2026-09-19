<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import type { Attachment } from "../lib/attachments";
  import { renderMarkdown } from "../lib/markdown";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { createMarkdownContentAction } from "./markdown-content-action";
  import { createMarkdownLinkAction } from "./markdown-link-action";

  let {
    text,
    compact = false,
    dense = false,
    fitTables = false,
    remoteImages = false,
    headingAnchors = false,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
  }: {
    text: string;
    compact?: boolean;
    dense?: boolean;
    fitTables?: boolean;
    remoteImages?: boolean;
    headingAnchors?: boolean;
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onValidateLocalFile?: (path: string) => Promise<boolean>;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onResolveProjectMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onResolveLocalMedia?: (path: string) => Promise<Attachment | undefined>;
  } = $props();
  let html = $derived(renderMarkdown(text, { remoteImages, headingAnchors }));
  let externalLinkIconTemplate: HTMLSpanElement | undefined;
  const markdownContent = createMarkdownContentAction({
    externalLinkIconTemplate: () => externalLinkIconTemplate,
    onValidateProjectFile: () => onValidateProjectFile,
    onValidateLocalFile: () => onValidateLocalFile,
    onResolveProjectMedia: () => onResolveProjectMedia,
    onResolveLocalMedia: () => onResolveLocalMedia,
  });
  const linkClicks = createMarkdownLinkAction({
    onOpenProjectFile: () => onOpenProjectFile,
    onOpenLocalFile: () => onOpenLocalFile,
  });
</script>

<span class="external-link-icon-template" aria-hidden="true" bind:this={externalLinkIconTemplate}>
  <ExternalLink size={14} strokeWidth={2} />
</span>
<div
  class={["markdown-text", compact && "compact", dense && "dense", fitTables && "fit-tables"]}
  use:linkClicks
  use:markdownContent={html}
>
  {@html html}
</div>

<style>
  .markdown-text {
    min-width: 0;
    line-height: 1.625;
    overflow-wrap: anywhere;
  }
  .markdown-text.dense { line-height: 1.5; }
  .markdown-text.compact.dense { line-height: 1.35; }

  :global(.markdown-text > :first-child) { margin-top: 0; }
  :global(.markdown-text > :last-child) { margin-bottom: 0; }
  .markdown-text :global(p) { margin: 0 0 0.75rem; }
  .markdown-text.compact :global(p) { margin-bottom: 0.35rem; }
  .markdown-text :global(strong) { font-weight: 600; }
  .markdown-text :global(em) {
    font-style: italic;
    font-synthesis: style;
  }
  .markdown-text :global(del) {
    color: var(--muted-foreground);
    text-decoration-thickness: 1px;
  }
  .markdown-text :global(h1),
  .markdown-text :global(h2),
  .markdown-text :global(h3),
  .markdown-text :global(h4),
  .markdown-text :global(h5),
  .markdown-text :global(h6) {
    margin: 1.1em 0 0.45em;
    color: color-mix(in srgb, var(--tool-warning) 78%, var(--foreground));
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .markdown-text :global(h1) { font-size: 1.35rem; }
  .markdown-text :global(h2) { font-size: 1.2rem; }
  .markdown-text :global(h3) { font-size: 1.08rem; }
  .markdown-text :global(h4),
  .markdown-text :global(h5),
  .markdown-text :global(h6) { font-size: 1rem; }
  .markdown-text.compact :global(h1),
  .markdown-text.compact :global(h2),
  .markdown-text.compact :global(h3),
  .markdown-text.compact :global(h4),
  .markdown-text.compact :global(h5),
  .markdown-text.compact :global(h6) { font-size: 1em; }
  .markdown-text.compact :global(h1),
  .markdown-text.compact :global(h2),
  .markdown-text.compact :global(h3),
  .markdown-text.compact :global(h4),
  .markdown-text.compact :global(h5),
  .markdown-text.compact :global(h6) { margin: 0.55em 0 0.25em; }
  .markdown-text :global(ul),
  .markdown-text :global(ol) {
    margin: 0.4rem 0 0.8rem;
    padding-left: 1.35rem;
  }
  .markdown-text.compact :global(ul),
  .markdown-text.compact :global(ol) { margin: 0.2rem 0 0.4rem; }
  .markdown-text :global(ul) { list-style: disc; }
  .markdown-text :global(ol) { list-style: decimal; }
  .markdown-text :global(li + li) { margin-top: 0.2rem; }
  .markdown-text.compact :global(li + li) { margin-top: 0.08rem; }
  .markdown-text :global(.task-item) {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    list-style: none;
  }
  .markdown-text :global(.task-item input) {
    width: 0.8rem;
    height: 0.8rem;
    margin: 0;
    accent-color: var(--primary);
  }
  .markdown-text :global(blockquote) {
    margin: 0.65rem 0;
    padding-left: 0.85rem;
    border-left: 2px solid var(--border);
    color: var(--muted-foreground);
  }
  .markdown-text.compact :global(blockquote) { margin: 0.3rem 0; }
  .markdown-text :global(hr) {
    margin: 1rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .markdown-text.compact :global(hr) { margin: 0.5rem 0; }
  .markdown-text :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);
    text-underline-offset: 2px;
  }
  .markdown-text :global(a:hover) { text-decoration-color: currentColor; }
  .external-link-icon-template { display: none; }
  .markdown-text :global(.markdown-external-link-icon) {
    display: inline-block;
    width: 0.82em;
    height: 0.82em;
    margin-inline-start: 0.22em;
    vertical-align: -0.06em;
  }
  .markdown-text :global(a[data-project-file]),
  .markdown-text :global(a[data-local-file]) {
    border-radius: var(--radius-sm);
    background: var(--code);
    box-decoration-break: clone;
    padding: 0.08em 0.3em;
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: max(0.92em, 0.75rem);
    -webkit-box-decoration-break: clone;
  }
  .markdown-text :global(a[data-project-file]:hover),
  .markdown-text :global(a[data-local-file]:hover) { background: var(--panel-hover); }
  .markdown-text :global(a[data-project-file] > code),
  .markdown-text :global(a[data-local-file] > code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  .markdown-text :global(.markdown-file-candidate > code) {
    color: var(--foreground);
  }
  .markdown-text :global(a:focus-visible) {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .markdown-text :global(.markdown-media) {
    display: flex;
    width: min(100%, 48rem);
    margin: 0.75rem 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
  }
  .markdown-text :global(.markdown-media-frame) {
    display: grid;
    width: fit-content;
    max-height: 28rem;
    max-width: 100%;
    place-items: center;
    overflow: hidden;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-lg);
    background: var(--code);
    color: var(--muted-foreground);
    text-decoration: none;
  }
  .markdown-text :global(a.markdown-media-frame) {
    cursor: pointer;
    transition: border-color 120ms ease, background-color 120ms ease;
  }
  .markdown-text :global(a.markdown-media-frame:hover) {
    border-color: var(--input);
    background: var(--accent);
  }
  .markdown-text :global(.markdown-media-content) {
    display: block;
    max-width: 100%;
    max-height: 28rem;
    object-fit: contain;
  }
  .markdown-text :global(.markdown-remote-image) {
    display: block;
    width: auto;
    max-width: 100%;
    max-height: 28rem;
    object-fit: contain;
  }
  .markdown-text :global(a > .markdown-remote-image) { cursor: pointer; }
  .markdown-text :global(video.markdown-media-content) {
    width: auto;
    background: var(--background);
  }
  .markdown-text :global(.markdown-media-status) {
    padding: 1rem;
    font-size: max(0.85em, 0.75rem);
  }
  .markdown-text :global(.markdown-media-caption) {
    display: block;
    max-width: 100%;
    color: var(--muted-foreground);
    font-size: max(0.85em, 0.75rem);
  }
  .markdown-text :global(.markdown-media-caption a[data-project-file]),
  .markdown-text :global(.markdown-media-caption a[data-local-file]) {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .markdown-text :global(code) {
    border-radius: var(--radius-sm);
    background: var(--code);
    padding: 0.12em 0.32em;
    color: var(--primary);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: max(0.88em, 0.75rem);
  }
  .markdown-text :global(pre) {
    width: fit-content;
    max-width: 100%;
    margin: 0.75rem 0;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-lg);
    background: var(--code);
    padding: 0.75rem;
  }
  .markdown-text :global(pre code) {
    display: block;
    width: auto;
    border-radius: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .markdown-text :global(pre code.highlighted-code) {
    /* Sugar High emits block line spans separated by literal newlines. */
    white-space: normal;
  }
  .markdown-text :global(.highlighted-code .sh__line) {
    display: block;
    min-height: 1.45em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .markdown-text :global(.table-scroll) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow-x: auto;
  }
  .markdown-text.fit-tables :global(.table-scroll) {
    width: 100%;
    overflow-x: visible;
  }
  .markdown-text :global(table) {
    width: max-content;
    border-collapse: collapse;
    border: 1px solid var(--border);
    font-size: max(0.94em, 0.75rem);
  }
  .markdown-text.fit-tables :global(table) {
    width: 100%;
    table-layout: auto;
  }
  .markdown-text :global(th),
  .markdown-text :global(td) {
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.65rem;
    text-align: left;
    vertical-align: top;
  }
  .markdown-text.fit-tables :global(th) {
    overflow-wrap: normal;
    word-break: normal;
    white-space: normal;
  }
  .markdown-text.fit-tables :global(td) {
    overflow-wrap: anywhere;
    word-break: normal;
    white-space: normal;
  }
  .markdown-text :global(th:last-child),
  .markdown-text :global(td:last-child) {
    border-right: 0;
  }
  .markdown-text :global(th) {
    background: var(--panel);
    font-weight: 600;
  }
  .markdown-text :global(.align-center) { text-align: center; }
  .markdown-text :global(.align-right) { text-align: right; }
  .markdown-text :global(.align-left) { text-align: left; }
  .markdown-text :global(.mermaid-diagram) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow-x: auto;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-lg);
    background: var(--panel);
    padding: 0.75rem;
  }
  .markdown-text :global(.mermaid-canvas) {
    min-height: 2rem;
    color: var(--muted-foreground);
  }
  .markdown-text :global(.mermaid-canvas svg) {
    display: block;
    height: auto;
    margin: 0 auto;
  }
  .markdown-text :global(.mermaid-fallback) {
    margin: 0;
  }
  .markdown-text :global(.mermaid-diagram[data-mermaid-state="rendered"] .mermaid-fallback) {
    display: none;
  }
  .markdown-text :global(.mermaid-error) {
    margin: 0 0 0.5rem;
    color: var(--destructive);
    font-size: max(0.9em, 0.75rem);
  }
</style>
