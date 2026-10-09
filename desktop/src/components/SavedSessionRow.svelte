<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import Check from "@lucide/svelte/icons/check";
  import { sessionIsFork, type SessionTreeRow } from "../lib/session-tabs";

  let { row, collapsed = false, related = false, selected = false, disabled = false,
    mode = "open", compact = true, date, onSelect, onToggle, onActivate,
  }: {
    row: SessionTreeRow; collapsed?: boolean; related?: boolean; selected?: boolean;
    disabled?: boolean; mode?: "open" | "delete"; compact?: boolean; date: string;
    onSelect: () => void; onToggle: () => void;
    onActivate: (active: boolean, source: "pointer" | "focus") => void;
  } = $props();
  const title = $derived(row.session.title || "Untitled conversation");
  const height = $derived(compact ? 28 : 44);
  const nodeX = $derived(row.depth * 18 + 9);
  const parentX = $derived(nodeX - 18);
</script>

<div
  data-saved-session-row={row.session.sessionId}
  data-related={related || undefined}
  role="group" aria-label={title}
  class={["session-row relative w-full text-foreground", compact ? "h-7 border-b border-border/50 last:border-b-0" : "h-11 rounded-md",
    related && "bg-panel-hover", selected && "bg-panel-selected"]}
  onpointerenter={() => onActivate(true, "pointer")} onpointerleave={() => onActivate(false, "pointer")}
  onfocusin={() => onActivate(true, "focus")}
  onfocusout={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onActivate(false, "focus"); }}
>
  <svg class={["pointer-events-none absolute top-0 left-0 z-10 h-full overflow-visible", related ? "text-primary/70" : "text-muted-foreground/40"]}
    width={nodeX + 9} viewBox={`0 0 ${nodeX + 9} ${height}`} fill="none" aria-hidden="true">
    {#each row.ancestorContinues as continues, index}
      {#if continues}<path d={`M ${index * 18 + 9} 0 V ${height}`} stroke="currentColor" />{/if}
    {/each}
    {#if row.depth > 0}
      <path d={`M ${parentX} 0 V ${height / 2 - 4} Q ${parentX} ${height / 2} ${parentX + 4} ${height / 2} H ${nodeX - 4}`} stroke="currentColor" />
      {#if !row.isLast}<path d={`M ${parentX} ${height / 2 - 4} V ${height}`} stroke="currentColor" />{/if}
    {/if}
    {#if row.hasChildren && !collapsed}
      <path d={`M ${nodeX} ${height / 2 + 7} V ${height}`} stroke="currentColor" />
    {/if}
    {#if !row.hasChildren}
      <circle cx={nodeX} cy={height / 2} r="2.5" fill="currentColor" />
    {/if}
  </svg>
  <button data-session-option type="button" {disabled} onclick={onSelect}
    aria-current={selected ? "true" : undefined} title={title}
    style:padding-left={`${nodeX + 13}px`}
    class={["flex h-full w-full min-w-0 items-center gap-3 pr-2.5 text-left hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:opacity-40",
      !compact && "rounded-md", mode === "delete" && "hover:text-destructive focus-visible:text-destructive"]}>
    <span class={["min-w-0 flex-1", compact && "flex items-center gap-1"]}>
      <strong class="flex min-w-0 items-center gap-1 text-xs font-medium">
        {#if selected}<Check class="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />{/if}
        {#if row.depth === 0 && sessionIsFork(row.session)}<GitFork class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
        <span class="min-w-0 truncate">{title}</span>
      </strong>
      {#if !compact}<small class="mt-0.5 block truncate text-xs text-muted-foreground">{date}</small>{/if}
    </span>
    {#if compact}<small class="shrink-0 font-mono text-xs text-muted-foreground">{date}</small>{/if}
  </button>
  {#if row.hasChildren}
    <button type="button" class="absolute top-0 z-20 grid h-full w-[18px] place-items-center text-muted-foreground hover:text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:opacity-40"
      style:left={`${row.depth * 18}px`} aria-label={`${collapsed ? "Expand" : "Collapse"} branches of ${title}`}
      aria-expanded={!collapsed} {disabled} onclick={onToggle}>
      <ChevronRight class={["h-3 w-3 transition-transform motion-reduce:transition-none", collapsed ? "rotate-0" : "rotate-90"]} aria-hidden="true" />
    </button>
  {/if}
</div>

<style>
  /* Keep strokes continuous across row separators. */
  .session-row > svg { height: calc(100% + 1px); }
</style>
