<script lang="ts">
  import {
    isShellDiffTool,
    structuredDiffModel,
    unifiedDiffModel,
    type ToolDiff,
  } from "../lib/diff";
  import { highlightCode, languageForReadTool } from "../lib/syntax-highlight";
  import DiffView from "./DiffView.svelte";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    content,
    kind,
    title,
    path,
    diffs = [],
    onOpenProjectFile,
  }: {
    content: string;
    kind: string;
    title: string;
    path?: string;
    diffs?: readonly ToolDiff[];
    onOpenProjectFile?: (path: string) => void | Promise<void>;
  } = $props();

  let language = $derived(languageForReadTool(kind, title, path));
  let renderAsMarkdown = $derived(language === "markdown");
  let highlighted = $derived(language && !renderAsMarkdown ? highlightCode(content, language) : undefined);
  let shellDiff = $derived(isShellDiffTool(kind, title) && content ? unifiedDiffModel(content) : undefined);
</script>

{#each diffs as diff}
  <DiffView model={structuredDiffModel(diff)} />
{/each}

{#if shellDiff}
  <DiffView model={shellDiff} label="git diff" />
{:else if content}
  {#if renderAsMarkdown}
    <div class="tool-result markdown-result"><MarkdownText text={content} {onOpenProjectFile} /></div>
  {:else if highlighted}
    <pre class="tool-result"><code class="highlighted-code" data-language={highlighted.language}>{@html highlighted.html}</code></pre>
  {:else}
    <pre class="tool-result">{content}</pre>
  {/if}
{/if}

<style>
  .tool-result {
    max-height: 220px;
    margin-top: 0.5rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    padding: 0.625rem 0.75rem;
    color: var(--foreground);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.625;
    white-space: pre-wrap;
  }

  .highlighted-code {
    display: block;
    min-width: 100%;
    font: inherit;
    white-space: inherit;
  }

  .highlighted-code :global(.sh__line) {
    display: block;
    min-height: 1em;
  }

  .markdown-result {
    font-family: inherit;
    font-size: 12px;
    white-space: normal;
  }
</style>
