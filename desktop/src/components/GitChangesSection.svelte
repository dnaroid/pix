<script lang="ts">
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { gitChangeCode, gitChangeLabel, gitChangeLineStats, type GitFileChange, type GitDiffScope } from "../lib/git";
  let { changes, scope, query, busy, onOpenDiff, onToggle, onDiscard }: {
    changes: GitFileChange[]; scope: "staged" | "unstaged"; query: string; busy: boolean;
    onOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onToggle: (path?: string) => void; onDiscard: (path: string) => void;
  } = $props();
  const visible = $derived(changes.filter((change) => change.path.toLowerCase().includes(query.trim().toLowerCase())));
  const isStaged = $derived(scope === "staged");
  const formatter = new Intl.NumberFormat("en-US");
  function tone(change: GitFileChange): string {
    const code = gitChangeCode(change, scope);
    return code === "!" ? "text-tool-error" : code === "A" || code === "U" ? "text-tool-success" : code === "D" ? "text-tool-warning" : "text-tool-info";
  }
</script>

<section aria-label={isStaged ? "Staged changes" : "Working tree changes"}>
  <header class="sticky top-0 z-[1] flex h-8 items-center gap-1.5 border-y border-sidebar-border bg-chrome px-2">
    <strong class="text-xs font-medium">{isStaged ? "Staged" : "Changes"}</strong>
    <span class="font-mono text-xs text-muted-foreground">{query ? `${visible.length}/` : ""}{changes.length}</span>
    {#if changes.length}
      <button class="ml-auto grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button"
        title={isStaged ? "Open staged diff" : "Open working-tree diff"} aria-label={isStaged ? "Open staged diff" : "Open working-tree diff"} disabled={busy} onclick={() => onOpenDiff(undefined, scope)}><FileDiff class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button class="inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={busy}
        title={`${isStaged ? "Unstage" : "Stage"} all ${changes.length} files, including filtered-out files`} onclick={() => onToggle()}>
        {#if isStaged}<Minus class="h-3 w-3" aria-hidden="true" />{:else}<Plus class="h-3 w-3" aria-hidden="true" />{/if}{isStaged ? "Unstage all" : "Stage all"}
      </button>
    {/if}
  </header>
  {#each visible as change (change.path)}
    {@const stats = gitChangeLineStats(change, scope)}
    {@const separator = change.path.lastIndexOf("/")}
    <div class="group flex h-8 min-w-0 items-center gap-1 px-2 hover:bg-sidebar-accent focus-within:bg-sidebar-accent">
      <button class="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" type="button" title={`${change.path} · ${gitChangeLabel(change, scope)}`} disabled={busy} onclick={() => onOpenDiff(change.path, scope)}>
        <span class={["w-3 shrink-0 text-center font-mono text-xs font-bold", tone(change)]}>{gitChangeCode(change, scope)}</span>
        <span class="truncate font-mono text-xs">{change.path.slice(separator + 1)}</span>
        {#if separator >= 0}<span class="min-w-0 truncate text-xs text-muted-foreground">{change.path.slice(0, separator)}</span>{/if}
      </button>
      {#if stats.additions !== undefined || stats.deletions !== undefined}
        <span class="flex shrink-0 gap-1 font-mono text-xs tabular-nums" aria-label={`${stats.additions ?? 0} additions, ${stats.deletions ?? 0} deletions`}>
          <span class="text-tool-success">+{formatter.format(stats.additions ?? 0)}</span><span class="text-tool-error">−{formatter.format(stats.deletions ?? 0)}</span>
        </span>
      {/if}
      {#if !isStaged && !change.untracked && !change.conflicted}
        <button class="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 hover:bg-panel-hover hover:text-tool-error focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30 group-hover:opacity-100 group-focus-within:opacity-100" type="button" disabled={busy} title={`Discard unstaged changes in ${change.path}…`} aria-label={`Discard unstaged changes in ${change.path}`} onclick={() => onDiscard(change.path)}><RotateCcw class="h-3 w-3" aria-hidden="true" /></button>
      {/if}
      <button class="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30" type="button" disabled={busy} title={`${isStaged ? "Unstage" : "Stage"} ${change.path}`} aria-label={`${isStaged ? "Unstage" : "Stage"} ${change.path}`} onclick={() => onToggle(change.path)}>
        {#if isStaged}<Minus class="h-3 w-3" aria-hidden="true" />{:else}<Plus class="h-3 w-3" aria-hidden="true" />{/if}
      </button>
    </div>
  {:else}
    <p class="px-3 py-2 text-xs text-muted-foreground">{query && changes.length ? "No matching files." : isStaged ? "Choose the files to include in your commit." : "No unstaged changes."}</p>
  {/each}
</section>
