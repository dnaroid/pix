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
  import type { Attachment } from "../lib/attachments";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import type { ToolItem } from "../lib/transcript";
  import { languageForToolInput, toolInputText } from "../lib/tool-input";
  import { subagentToolTargets } from "../lib/subagent-tool-targets";
  import DiffView from "./DiffView.svelte";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    tool,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
    onOpenSubagentSession,
  }: {
    tool: ToolItem;
    onValidateProjectFile?: (path: string) => Promise<boolean | "directory">;
    onValidateLocalFile?: (path: string) => Promise<boolean | "directory">;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onResolveProjectMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onResolveLocalMedia?: (path: string) => Promise<Attachment | undefined>;
    onOpenSubagentSession?: (runDir: string, agentId: string) => void;
  } = $props();

  let language = $derived(languageForReadTool(tool.kind, tool.title, tool.path));
  let inputText = $derived(toolInputText(tool));
  let inputLanguage = $derived(languageForToolInput(tool));
  let highlightedInput = $derived(inputText !== undefined && inputLanguage ? highlightCode(inputText, inputLanguage) : undefined);
  let renderAsMarkdown = $derived(language === "markdown");
  let highlighted = $derived(language && !renderAsMarkdown ? highlightCode(tool.content, language) : undefined);
  let shellDiff = $derived(isShellDiffTool(tool.kind, tool.title) && tool.content ? unifiedDiffModel(tool.content) : undefined);
  let mutationDiffs = $derived(mutationDiffPresentations(tool));
  let mutationLines = $derived(isMutationTool(tool) ? mutationOutputLines(tool.content) : undefined);
  let subagentTargets = $derived(onOpenSubagentSession ? subagentToolTargets(tool) : []);
</script>

{#if inputText !== undefined}
  <section aria-label="Tool input">
    <div class="tool-section-label">Input</div>
    <pre class="tool-result tool-input">{#if highlightedInput}<code class="highlighted-code" data-language={highlightedInput.language}>{@html highlightedInput.html}</code>{:else}{inputText}{/if}</pre>
  </section>
  {#if tool.content || shellDiff || mutationDiffs.length > 0}
    <div class="tool-section-label">Result</div>
  {/if}
{/if}

{#each mutationDiffs as diff}
  <DiffView model={diff.model} label={diff.label} />
{/each}

{#if shellDiff}
  <DiffView model={shellDiff} label="git diff" />
{:else if tool.content}
  {#if renderAsMarkdown}
    <div class="tool-result markdown-result"><MarkdownText text={tool.content} compact dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} /></div>
  {:else if highlighted}
    <pre class="tool-result"><code class="highlighted-code" data-language={highlighted.language}>{@html highlighted.html}</code></pre>
  {:else if mutationLines}
    <pre class="tool-result mutation-result">{#each mutationLines as line}<span data-tone={line.tone}>{line.text || " "}</span>{/each}</pre>
  {:else}
    <pre class="tool-result">{tool.content}</pre>
  {/if}
{/if}

{#if subagentTargets.length > 0 && onOpenSubagentSession}
  <div class="subagent-targets" role="group" aria-label="Sub-agent sessions">
    {#each subagentTargets as target (target.runDir + "\0" + target.agentId)}
      <button
        type="button"
        class="subagent-target"
        title={`Open read-only session of sub-agent ${target.agentId}`}
        onclick={() => onOpenSubagentSession(target.runDir, target.agentId)}
      >Open {target.agentId} session</button>
    {/each}
  </div>
{/if}

<style>
  .subagent-targets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.375rem;
  }

  .subagent-target {
    border: 1px solid var(--code-border);
    border-radius: var(--radius-md);
    padding: 0.125rem 0.5rem;
    color: var(--foreground);
    font-size: 12px;
    line-height: 1.4;
  }

  .subagent-target:hover { background: var(--accent); }
  .subagent-target:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

  .tool-result {
    max-height: min(480px, 60vh);
    margin-top: 0.25rem;
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-lg);
    background: var(--code);
    padding: 0.5rem 0.625rem;
    color: var(--foreground);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.35;
    white-space: pre-wrap;
  }

  .tool-section-label {
    margin-top: 0.5rem;
    color: var(--muted-foreground);
    font-size: 12px;
    font-weight: 600;
  }

  .highlighted-code {
    display: block;
    min-width: 100%;
    font: inherit;
    white-space: normal;
  }

  .highlighted-code :global(.sh__line) {
    display: block;
    min-height: 1.35em;
    white-space: pre;
  }

  .tool-input .highlighted-code :global(.sh__line) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
