<script lang="ts">
  import ChartNoAxesCombined from "@lucide/svelte/icons/chart-no-axes-combined";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { RuntimeStatus } from "../lib/acp-client";
  import { dcpContextMap, dcpContextVisualization, type DcpContextMapCellKind } from "../lib/dcp-context-visualization";
  import { formatCompactTokens } from "../lib/runtime-status";
  import { parseDcpContextMap } from "../lib/dcp-context-map";

  let { status }: { status: RuntimeStatus | undefined } = $props();

  const view = $derived(dcpContextVisualization(status));
  const prepared = $derived(parseDcpContextMap(status?.dcpContextMap));
  const contextMap = $derived(dcpContextMap(view.context, prepared));
  const categoryTokens = $derived(contextMap.categoryTokens ?? prepared?.tokenEstimates);
  const occupancyPercent = $derived(contextMap.occupiedPercent);
  const categoryLabels: Record<DcpContextMapCellKind, string> = {
    free: "Free", retained: "Other occupied", candidate: "Compression candidates",
    protected: "Incomplete tool groups", compressed: "Current summaries", occupied: "Occupied", unknown: "Unknown",
  };
  function formatEstimate(tokens: number): string {
    return tokens > 0 && tokens < 1 ? "<1" : formatCompactTokens(tokens);
  }
  function mapCellClass(kind: DcpContextMapCellKind): string {
    if (kind === "free") return "bg-panel-hover";
    if (kind === "retained") return "bg-muted-foreground/35";
    if (kind === "candidate") return "bg-tool-warning";
    if (kind === "protected") return "bg-tool-error";
    if (kind === "compressed") return "bg-tool-success";
    if (kind === "occupied") return "bg-tool-info";
    return "bg-muted";
  }
</script>

<details class="group border-b border-border" open>
  <summary class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2.5 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
    <ChartNoAxesCombined class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span class="font-semibold uppercase tracking-wide text-foreground">DCP</span>
    <span class="ml-auto font-mono tabular-nums text-muted-foreground">
      {#if occupancyPercent !== undefined}{Math.round(occupancyPercent)}% occupied{/if}
      {#if occupancyPercent !== undefined && view.liveTokensSaved !== undefined} · {/if}
      {#if view.liveTokensSaved !== undefined}saved ~{formatCompactTokens(view.liveTokensSaved)}{:else if occupancyPercent === undefined}unknown{/if}
    </span>
    <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
  </summary>

  <div class="space-y-3 px-2.5 py-3">
    <div>
      <div class="mb-1 flex items-baseline justify-between gap-2">
        <span class="text-xs font-medium">Context · tokens</span>
        {#if view.context && view.context.tokens !== null && occupancyPercent !== undefined}
          <span class="font-mono text-xs tabular-nums text-muted-foreground">{formatCompactTokens(view.context.tokens)} / {formatCompactTokens(view.context.contextWindow)}</span>
        {:else}
          <span class="font-mono text-xs text-muted-foreground">unknown</span>
        {/if}
      </div>
      <div
        class="grid grid-cols-10 gap-px rounded-sm bg-border p-px max-[340px]:grid-cols-8"
        role="img"
        aria-label={contextMap.occupiedPercent === undefined
          ? "Context capacity is unknown; no free capacity is inferred."
          : `Context token-volume capacity map: ${Math.round(contextMap.occupiedPercent)}% occupied. Cells are grouped capacity shares, not message positions.`}
      >
        {#each contextMap.cells as cell}
          <span class="flex aspect-square min-w-0 overflow-hidden" aria-hidden="true" title={cell.segments.map((segment) => categoryLabels[segment.kind]).join(" · ")}>
            {#each cell.segments as segment}<span class={["min-w-0 flex-1", mapCellClass(segment.kind)]} style:flex-grow={segment.share}></span>{/each}
          </span>
        {/each}
      </div>
      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-4 text-muted-foreground" aria-label="Context map legend">
        {#if contextMap.occupiedPercent === undefined}
          <span class="inline-flex items-center gap-1"><i class="h-2 w-2 shrink-0 bg-muted" aria-hidden="true"></i>Capacity unknown</span>
        {/if}
        {#if categoryTokens}
          <span class="inline-flex items-center gap-1" title="Other occupied content, including overhead not classified by DCP"><i class="h-2 w-2 shrink-0 bg-muted-foreground/35" aria-hidden="true"></i>Other ~{formatEstimate(categoryTokens.retained)}</span>
          <span class="inline-flex items-center gap-1" title="Advisory compression candidates, not permission to delete"><i class="h-2 w-2 shrink-0 bg-tool-warning" aria-hidden="true"></i>Candidates ~{formatEstimate(categoryTokens.candidate)}</span>
          <span class="inline-flex items-center gap-1" title="Incomplete tool groups only; other protected content may be included in Other"><i class="h-2 w-2 shrink-0 bg-tool-error" aria-hidden="true"></i>Protected ~{formatEstimate(categoryTokens.protected)}</span>
          <span class="inline-flex items-center gap-1" title="Current summary size, not the original compressed content"><i class="h-2 w-2 shrink-0 bg-tool-success" aria-hidden="true"></i>Summaries ~{formatEstimate(categoryTokens.compressed)}</span>
        {:else if contextMap.occupiedPercent !== undefined}
          <span class="inline-flex items-center gap-1"><i class="h-2 w-2 shrink-0 bg-tool-info" aria-hidden="true"></i>Occupied ~{formatCompactTokens(contextMap.occupiedTokens ?? 0)}</span>
        {/if}
        {#if contextMap.occupiedPercent !== undefined}
          <span class="inline-flex items-center gap-1"><i class="h-2 w-2 shrink-0 bg-panel-hover ring-1 ring-border" aria-hidden="true"></i>Free ~{formatCompactTokens(contextMap.freeTokens ?? 0)}</span>
        {/if}
      </div>
      <p class="mt-1 text-xs leading-4 text-muted-foreground">
        {#if contextMap.occupiedPercent !== undefined}{Math.round(contextMap.occupiedPercent)}% occupied{#if contextMap.hasEstimates} · DCP volumes are approximate{contextMap.estimatesScaled ? " and scaled to live occupancy" : ""}{/if}{:else}Live capacity is unavailable; snapshot estimates cannot determine free space.{/if}
      </p>
    </div>

    {#if prepared}
      <p class="-mt-2 text-xs leading-4 text-muted-foreground" title={`Last prepared snapshot · r${prepared.revision} · ${new Date(prepared.generatedAt).toISOString()}`}>Prepared {new Date(prepared.generatedAt).toLocaleString()} · candidates are advisory, not deletions.</p>
    {:else}
      <p class="-mt-2 text-xs leading-4 text-muted-foreground">DCP category estimates are unavailable.</p>
    {/if}

    <div class="grid grid-cols-2 gap-2">
      <div class="min-w-0" title="DCP's live estimate of tokens removed by pruning or compression. It is not measured commit gain or a billing counter.">
        <p class="text-xs text-muted-foreground">DCP saved</p>
        <p class="mt-0.5 font-mono text-xs tabular-nums text-foreground">{view.liveTokensSaved === undefined ? "unknown" : `~${formatCompactTokens(view.liveTokensSaved)}`}</p>
      </div>
      <div class="min-w-0" title="Sum of positive gains recorded for measured compression commits. Old unmeasured commits remain unknown and this is not current context savings.">
        <p class="text-xs text-muted-foreground">Measured gain</p>
        <p class="mt-0.5 font-mono text-xs tabular-nums text-foreground">{view.measuredGain ? `${formatCompactTokens(view.measuredGain.tokens)} · ${view.measuredGain.commits}` : "unknown"}</p>
      </div>
    </div>

    {#if view.projection}
      <div title="Last prepared DCP request. Input/projection counts message estimates only; they do not include system prompt, tool schemas, or billing.">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="text-xs font-medium">Last projection</span>
          <span class="font-mono text-xs tabular-nums text-muted-foreground">{formatCompactTokens(view.projection.raw)} → {formatCompactTokens(view.projection.projected)}</span>
        </div>
        <p class="mt-1 text-xs leading-4 text-muted-foreground">~{formatCompactTokens(Math.max(0, view.projection.raw - view.projection.projected))} projected reduction</p>
      </div>
    {/if}

    {#if view.blocks}
      <div title="Active, retired, and total journal blocks on the full active branch. A block count is not an operation count.">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="text-xs font-medium">Journal blocks</span>
          <span class="font-mono text-xs tabular-nums text-muted-foreground">{view.blocks.active} active · {view.blocks.retired} retired</span>
        </div>
      </div>
    {:else if view.historyUnavailable}
      <p class="text-xs leading-4 text-muted-foreground">Journal blocks and measured gains are unknown because full history is unavailable.</p>
    {:else if status?.dcpStats}
      <p class="text-xs leading-4 text-muted-foreground">Journal block state has not been recorded yet.</p>
    {/if}
  </div>
</details>
