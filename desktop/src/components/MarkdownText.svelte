<script lang="ts">
  import { renderMarkdown } from "../lib/markdown";

  let { text, compact = false }: { text: string; compact?: boolean } = $props();
  let html = $derived(renderMarkdown(text));
</script>

<div class:compact class="markdown-text">{@html html}</div>

<style>
  .markdown-text {
    min-width: 0;
    line-height: 1.625;
    overflow-wrap: anywhere;
  }

  :global(.markdown-text > :first-child) { margin-top: 0; }
  :global(.markdown-text > :last-child) { margin-bottom: 0; }
  .markdown-text :global(p) { margin: 0 0 0.75rem; }
  .markdown-text :global(h1),
  .markdown-text :global(h2),
  .markdown-text :global(h3),
  .markdown-text :global(h4),
  .markdown-text :global(h5),
  .markdown-text :global(h6) {
    margin: 1.1em 0 0.45em;
    color: inherit;
    font-weight: 600;
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
  .markdown-text :global(ul),
  .markdown-text :global(ol) {
    margin: 0.4rem 0 0.8rem;
    padding-left: 1.35rem;
  }
  .markdown-text :global(ul) { list-style: disc; }
  .markdown-text :global(ol) { list-style: decimal; }
  .markdown-text :global(li + li) { margin-top: 0.2rem; }
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
  .markdown-text :global(hr) {
    margin: 1rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .markdown-text :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);
    text-underline-offset: 2px;
  }
  .markdown-text :global(a:hover) { text-decoration-color: currentColor; }
  .markdown-text :global(a:focus-visible) {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .markdown-text :global(code) {
    border-radius: var(--radius-sm);
    background: var(--muted);
    padding: 0.12em 0.32em;
    color: var(--foreground);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 0.88em;
  }
  .markdown-text :global(pre) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    padding: 0.75rem;
  }
  .markdown-text :global(pre code) {
    display: block;
    width: max-content;
    min-width: 100%;
    border-radius: 0;
    background: transparent;
    padding: 0;
    white-space: pre;
  }
  .markdown-text :global(.table-scroll) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow-x: auto;
  }
  .markdown-text :global(table) {
    min-width: 100%;
    border-collapse: collapse;
    font-size: 0.94em;
  }
  .markdown-text :global(th),
  .markdown-text :global(td) {
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.65rem;
    text-align: left;
    vertical-align: top;
  }
  .markdown-text :global(th) {
    background: color-mix(in srgb, var(--muted) 65%, transparent);
    font-weight: 600;
  }
  .markdown-text :global(.align-center) { text-align: center; }
  .markdown-text :global(.align-right) { text-align: right; }
  .markdown-text :global(.align-left) { text-align: left; }
</style>
