<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { untrack, type ComponentProps } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { Attachment } from "../lib/attachments";
  import { isUserBashTool, toolPresentation } from "../lib/tool-presentation";
  import { toolGroupAttention, toolLspAttention } from "../lib/tool-output";
  import {
    activityEntryActive,
    activityGroupDuration,
    activityGroupPresentationLabels,
    formatTranscriptDuration,
  } from "../lib/transcript-presentation";
  import type { ActivityEntry, ActivityGroupItem } from "../lib/transcript";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolResult from "./ToolResult.svelte";
  import ToolStatusIcon from "./ToolStatusIcon.svelte";

  let {
    item, nowMs, gapClass = "", onLoadToolResult, onOpenAttachment, onPrepareAttachment,
    onValidateProjectFile, onValidateLocalFile, onOpenProjectFile,
    onResolveProjectMedia, onOpenLocalFile, onResolveLocalMedia,
  }: {
    item: ActivityGroupItem;
    /** Shared pane clock, supplied only to live groups. */
    nowMs?: number;
    gapClass?: string;
    onLoadToolResult: (toolCallId: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
    onPrepareAttachment: (attachment: Attachment) => Promise<void>;
  } & Omit<ComponentProps<typeof ToolResult>, "tool"> = $props();

  const initiallyOpen = untrack(() => item.tools.filter(isUserBashTool).map((tool) => tool.id));
  let expanded = $state(initiallyOpen.length > 0);
  // Preserve individual disclosures when the outer group is collapsed, but do
  // not keep their Markdown, diffs or attachment components mounted offscreen.
  const expandedEntries = new SvelteSet(initiallyOpen);
  const labels = $derived(activityGroupPresentationLabels(item.entries));
  const attention = $derived(toolGroupAttention(item.tools));
  const durationMs = $derived(activityGroupDuration(item, nowMs));

  function toggleEntry(event: Event, entry: ActivityEntry): void {
    if (event.target !== event.currentTarget) return;
    const details = event.currentTarget as HTMLDetailsElement;
    if (details.open) expandedEntries.add(entry.id);
    else expandedEntries.delete(entry.id);
    // Only the requested body is hydrated, never the entire activity group.
    // The session-history controller owns generation-aware request deduplication.
    if (details.open && entry.type === "tool" && entry.deferredResult) onLoadToolResult(entry.toolCallId);
  }
</script>

<details
  bind:open={expanded}
  data-transcript-entry-id={item.id}
  class={["transcript-entry group/activity w-full min-w-0 overflow-hidden bg-transparent text-muted-foreground/80", gapClass, item.status === "failed" && "text-destructive"]}
>
  <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/activity:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
    <ToolStatusIcon status={item.status} {attention} class="h-3 w-3 opacity-75" />
    <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden text-xs">
      <span class="min-w-0 truncate">
        {#each labels as label, index (label.name)}
          {#if index > 0}<span class="text-muted-foreground/45">, </span>{/if}
          <strong
            data-activity-name={label.name}
            data-activity-active={label.active}
            aria-label={label.active ? `${label.name} (active)` : undefined}
            class={label.active ? "font-medium text-primary" : "font-normal text-muted-foreground/85"}
          >{label.name}</strong>
        {/each}
      </span>
      {#if durationMs !== undefined}<span data-activity-duration class="shrink-0 text-muted-foreground/45">{formatTranscriptDuration(durationMs)}</span>{/if}
    </span>
  </summary>
  {#if expanded}
    <div class="mt-1 ml-[7px] space-y-0.5 border-l border-code-border pl-2.5">
      {#each item.entries as entry (entry.id)}
        {#if entry.type === "message"}
          {@const active = activityEntryActive(entry)}
          <details class="group/thought" data-activity-entry-id={entry.id} open={expandedEntries.has(entry.id)} ontoggle={(event) => toggleEntry(event, entry)}>
            <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/thought:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              <Brain class={["h-3 w-3 shrink-0", active ? "text-primary" : "text-primary/65"]} aria-hidden="true" />
              <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden text-xs">
                <span class={active ? "font-medium text-primary" : "text-muted-foreground/85"}>thinking</span>
                {#if entry.startedAtMs !== undefined && entry.endedAtMs !== undefined}
                  <span class="shrink-0 text-muted-foreground/45">{formatTranscriptDuration(entry.endedAtMs - entry.startedAtMs)}</span>
                {/if}
              </span>
            </summary>
            {#if expandedEntries.has(entry.id)}
              <div class="ml-[7px] border-l border-code-border pl-2.5 text-muted-foreground">
                <MarkdownText text={entry.text} compact dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
              </div>
            {/if}
          </details>
        {:else}
          {@const tool = entry}
          {@const presentation = toolPresentation(tool)}
          {@const toolAttention = toolLspAttention(tool)}
          <section data-activity-entry-id={tool.id}>
            {#if tool.deferredResult || tool.content || tool.diffs.length > 0 || tool.attachments.length > 0}
              <details class="group/result" open={expandedEntries.has(tool.id)} ontoggle={(event) => toggleEntry(event, tool)}>
                <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/result:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                  <ToolStatusIcon status={tool.status} attention={toolAttention} class="h-3 w-3 opacity-80" />
                  <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                    <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                    {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                  </span>
                </summary>
                {#if expandedEntries.has(tool.id)}
                  {#if tool.resultLoading}
                    <div class="py-0.5 pl-8 text-xs leading-tight text-muted-foreground" role="status">Loading tool result…</div>
                  {:else if tool.resultError}
                    <div class="py-0.5 pl-8 text-xs leading-tight text-destructive" role="status">{tool.resultError}</div>
                  {/if}
                  <AttachmentGrid attachments={tool.attachments} variant="tool" onOpen={onOpenAttachment} onPrepare={onPrepareAttachment} />
                  {#if !tool.resultLoading && (tool.content || tool.diffs.length > 0)}
                    <ToolResult {tool} {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
                  {/if}
                {/if}
              </details>
            {:else}
              <div class="grid min-h-4 grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight">
                <span aria-hidden="true"></span>
                <ToolStatusIcon status={tool.status} attention={toolAttention} class="h-3 w-3 opacity-80" />
                <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                  <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                  {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                </span>
              </div>
            {/if}
          </section>
        {/if}
      {/each}
    </div>
  {/if}
</details>

<style>
  .transcript-entry { content-visibility: auto; contain-intrinsic-size: auto 120px; }
  .tool-name[data-tool-tone="accent"] { color: var(--tool-accent); }
  .tool-name[data-tool-tone="info"] { color: var(--tool-info); }
  .tool-name[data-tool-tone="muted"] { color: var(--tool-muted); }
  .tool-name[data-tool-tone="mutation"] { color: var(--tool-mutation); }
  .tool-name[data-tool-tone="search"] { color: var(--tool-search); }
  .tool-name[data-tool-tone="success"] { color: var(--tool-success); }
  .tool-name[data-tool-tone="title"] { color: var(--tool-title); }
  .tool-name[data-tool-tone="warning"] { color: var(--tool-warning); }
</style>
