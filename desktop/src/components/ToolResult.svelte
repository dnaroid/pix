<script lang="ts">
  import {
    isShellDiffTool,
    unifiedDiffModel,
  } from "../lib/diff";
  import { highlightCode, languageForReadTool } from "../lib/syntax-highlight";
  import {
    isMutationTool,
    mutationDiffPresentations,
    mutationOutputLines,
  } from "../lib/tool-output";
  import type { ToolItem } from "../lib/transcript";
  import DiffView from "./DiffView.svelte";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    tool,
    onOpenProjectFile,
  }: {
    tool: ToolItem;
    onOpenProjectFile?: (path: string) => void | Promise<void>;
  } = $props();

  let language = $derived(languageForReadTool(tool.kind, tool.title, tool.path));
  let renderAsMarkdown = $derived(language === "markdown");
  let highlighted = $derived(language && !renderAsMarkdown ? highlightCode(tool.content, language) : undefined);
  let shellDiff = $derived(isShellDiffTool(tool.kind, tool.title) && tool.content ? unifiedDiffModel(tool.content) : undefined);
  let mutationDiffs = $derived(mutationDiffPresentations(tool));
  let mutationLines = $derived(isMutationTool(tool) ? mutationOutputLines(tool.content) : undefined);
</script>

{#each mutationDiffs as diff}
  <DiffView model={diff.model} label={diff.label} />
{/each}

{#if shellDiff}
  <DiffView model={shellDiff} label="git diff" />
{:else if tool.content}
  {#if renderAsMarkdown}
    <div class="tool-result markdown-result"><MarkdownText text={tool.content} {onOpenProjectFile} /></div>
  {:else if highlighted}
    <pre class="tool-result"><code class="highlighted-code" data-language={highlighted.language}>{@html highlighted.html}</code></pre>
  {:else if mutationLines}
    <pre class="tool-result mutation-result">{#each mutationLines as line}<span data-tone={line.tone}>{line.text || " "}</span>{/each}</pre>
  {:else}
    <pre class="tool-result">{tool.content}</pre>
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
    white-space: normal;
  }

  .highlighted-code :global(.sh__line) {
    display: block;
    min-height: 1.625em;
    white-space: pre;
  }

  .markdown-result {
    font-family: inherit;
    font-size: 12px;
    white-space: normal;
  }

  .mutation-result span { display: block; }
  .mutation-result span[data-tone="label"] { color: var(--tool-info); font-weight: 600; }
  .mutation-result span[data-tone="error"] { color: var(--tool-error); }
  .mutation-result span[data-tone="warning"] { color: var(--tool-warning); }
  .mutation-result span[data-tone="hint"] { color: var(--muted-foreground); }
  .mutation-result span[data-tone="success"] { color: var(--tool-success); }
</style>
