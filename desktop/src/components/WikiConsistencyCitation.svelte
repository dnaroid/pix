<script lang="ts">
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { ProjectFileLineRange } from "../lib/project-files";

  let { citation, label, language, canOpen = false, openLabel, blockedLabel, onOpenCitation, onOpenSource }: {
    citation: KnowledgeCitation;
    label?: string;
    language?: KnowledgeReportLanguage;
    canOpen?: boolean;
    openLabel: string;
    blockedLabel: string;
    onOpenCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onOpenSource?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
  } = $props();

  const location = $derived(`${citation.path}:L${citation.startLine}${citation.endLine === citation.startLine ? "" : `–${citation.endLine}`}`);
  function open(): void {
    if (!canOpen) return;
    if (onOpenCitation) void onOpenCitation(citation, language);
    else void onOpenSource?.(citation.path, { startLine: citation.startLine, endLine: citation.endLine });
  }
</script>

<div class="min-w-0" data-wiki-report-citation>
  {#if label}<p class="mb-1 font-medium text-muted-foreground">{label}</p>{/if}
  {#if onOpenCitation || onOpenSource}
    <button
      class="max-w-full break-all text-left font-mono text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:cursor-default disabled:no-underline"
      type="button"
      disabled={!canOpen}
      title={canOpen ? openLabel : blockedLabel}
      aria-label={`${openLabel}: ${location}`}
      onclick={open}
    >{location}</button>
  {:else}
    <p class="break-all font-mono text-muted-foreground">{location}</p>
  {/if}
  <blockquote class="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 leading-relaxed">{citation.quote}</blockquote>
</div>
