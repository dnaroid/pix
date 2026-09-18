import type { RuntimeStatus } from "./acp-client";
import { parseDcpContextMap, type PreparedDcpContextMap } from "./dcp-context-map";

export interface DcpContextVisualization {
  readonly context?: RuntimeStatus["context"];
  readonly liveTokensSaved?: number;
  readonly blocks?: { active: number; retired: number; total: number };
  readonly projection?: { raw: number; projected: number };
  readonly measuredGain?: { tokens: number; commits: number };
  readonly historyUnavailable: boolean;
}

export const DCP_CONTEXT_MAP_CELL_COUNT = 40;

export type DcpContextMapCellKind = "free" | "retained" | "candidate" | "protected" | "compressed" | "occupied" | "unknown";

export interface DcpContextMapCell {
  readonly segments: readonly { readonly kind: DcpContextMapCellKind; readonly share: number }[];
}

export interface DcpContextMapCategoryTokens {
  readonly retained: number;
  readonly candidate: number;
  readonly protected: number;
  readonly compressed: number;
}

export interface DcpContextMap {
  readonly cells: readonly DcpContextMapCell[];
  readonly occupiedTokens?: number;
  readonly freeTokens?: number;
  readonly categoryTokens?: DcpContextMapCategoryTokens;
  readonly hasEstimates: boolean;
  readonly estimatesScaled: boolean;
  readonly occupiedPercent?: number;
}

/**
 * Extract only labeled, scalar values from the shared DCP formatter. The report
 * remains authoritative: an absent or unknown value stays absent here.
 */
export function dcpContextVisualization(status: RuntimeStatus | undefined): DcpContextVisualization {
  const report = status?.dcpStats;
  const blocks = parseBlocks(report);
  const projection = parseProjection(report);
  const measuredGain = parseMeasuredGain(report);
  return {
    ...(status?.context ? { context: status.context } : {}),
    ...(status?.dcpTokensSaved !== undefined ? { liveTokensSaved: status.dcpTokensSaved } : {}),
    ...(blocks ? { blocks } : {}),
    ...(projection ? { projection } : {}),
    ...(measuredGain ? { measuredGain } : {}),
    historyUnavailable: /History unavailable:|Blocks, gains and reminders: unknown/i.test(report ?? ""),
  };
}

/**
 * Quantize live SDK occupancy into a bounded aggregate waffle map. Cells are
 * capacity shares, not message positions. Prepared DCP telemetry only classifies
 * token volume; a candidate remains advisory and is never deletion authority.
 */
export function dcpContextMap(
  context: RuntimeStatus["context"] | undefined,
  telemetry?: PreparedDcpContextMap,
): DcpContextMap {
  if (!hasUsableContextDenominator(context)) {
    return {
      cells: unknownCells(),
      hasEstimates: false,
      estimatesScaled: false,
    };
  }

  const occupiedTokens = context.tokens;
  const freeTokens = Math.max(0, context.contextWindow - occupiedTokens);
  const parsed = parseDcpContextMap(telemetry);
  const categoryTokens = parsed ? fitEstimates(parsed.tokenEstimates, occupiedTokens) : undefined;
  const displayTokens = categoryTokens
    ? scaleCategories(categoryTokens, Math.min(occupiedTokens, context.contextWindow))
    : undefined;
  const segments: { kind: DcpContextMapCellKind; tokens: number }[] = displayTokens
    ? [
      { kind: "retained", tokens: displayTokens.retained },
      { kind: "candidate", tokens: displayTokens.candidate },
      { kind: "protected", tokens: displayTokens.protected },
      { kind: "compressed", tokens: displayTokens.compressed },
      { kind: "free", tokens: freeTokens },
    ]
    : [{ kind: "occupied", tokens: Math.min(occupiedTokens, context.contextWindow) }, { kind: "free", tokens: freeTokens }];
  return {
    cells: tokenizeCells(segments, context.contextWindow),
    occupiedTokens,
    freeTokens,
    ...(categoryTokens ? { categoryTokens } : {}),
    hasEstimates: Boolean(categoryTokens),
    estimatesScaled: Boolean(parsed && sum(parsed.tokenEstimates) > occupiedTokens),
    occupiedPercent: (context.tokens / context.contextWindow) * 100,
  };
}

function unknownCells(): DcpContextMapCell[] {
  return Array.from({ length: DCP_CONTEXT_MAP_CELL_COUNT }, () => ({ segments: [{ kind: "unknown", share: 1 }] }));
}

function tokenizeCells(segments: readonly { kind: DcpContextMapCellKind; tokens: number }[], window: number): DcpContextMapCell[] {
  let cursor = 0;
  const spans = segments.map((segment) => {
    const start = cursor;
    cursor += segment.tokens;
    return { ...segment, start, end: cursor };
  });
  return Array.from({ length: DCP_CONTEXT_MAP_CELL_COUNT }, (_, index) => {
    const start = index * window / DCP_CONTEXT_MAP_CELL_COUNT;
    const end = (index + 1) * window / DCP_CONTEXT_MAP_CELL_COUNT;
    return {
      segments: spans.flatMap((span) => {
        const overlap = Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
        return overlap > 0 ? [{ kind: span.kind, share: overlap / (end - start) }] : [];
      }),
    };
  });
}

function fitEstimates(estimates: DcpContextMapCategoryTokens, occupied: number): DcpContextMapCategoryTokens {
  const total = sum(estimates);
  if (total <= occupied) return { ...estimates, retained: estimates.retained + occupied - total };
  return scaleCategories(estimates, occupied);
}

/** Keep fractional estimates so scaling cannot silently erase minority categories. */
function scaleCategories(categories: DcpContextMapCategoryTokens, target: number): DcpContextMapCategoryTokens {
  const total = sum(categories);
  if (total === target) return { ...categories };
  const scale = total > 0 ? target / total : 0;
  return {
    retained: categories.retained * scale,
    candidate: categories.candidate * scale,
    protected: categories.protected * scale,
    compressed: categories.compressed * scale,
  };
}

function sum(categories: DcpContextMapCategoryTokens): number {
  return categories.retained + categories.candidate + categories.protected + categories.compressed;
}

function hasUsableContextDenominator(
  context: RuntimeStatus["context"] | undefined,
): context is NonNullable<RuntimeStatus["context"]> & { tokens: number } {
  if (!context || context.tokens === null) return false;
  return Number.isSafeInteger(context.tokens)
    && context.tokens >= 0
    && Number.isSafeInteger(context.contextWindow)
    && context.contextWindow > 0;
}

function parseBlocks(report: string | undefined): DcpContextVisualization["blocks"] | undefined {
  const match = report?.match(/Blocks:\s+(\d+) active\s*\/\s*(\d+) retired\s*\/\s*(\d+) total/i);
  if (!match) return undefined;
  const active = parseInteger(match[1]!);
  const retired = parseInteger(match[2]!);
  const total = parseInteger(match[3]!);
  if (active === undefined || retired === undefined || total === undefined || active + retired !== total) return undefined;
  return { active, retired, total };
}

function parseProjection(report: string | undefined): DcpContextVisualization["projection"] | undefined {
  const match = report?.match(/Input\/projection:\s*~?([\d,]+)\s*->\s*~?([\d,]+)/i);
  if (!match || !match[1] || !match[2]) return undefined;
  const raw = parseInteger(match[1]);
  const projected = parseInteger(match[2]);
  if (raw === undefined || projected === undefined) return undefined;
  return { raw, projected };
}

function parseMeasuredGain(report: string | undefined): DcpContextVisualization["measuredGain"] | undefined {
  const match = report?.match(/Measured commit gain:\s*([\d,]+) tokens\s*\(([\d,]+) measured commits\)/i);
  if (!match || !match[1] || !match[2]) return undefined;
  const tokens = parseInteger(match[1]);
  const commits = parseInteger(match[2]);
  if (tokens === undefined || commits === undefined) return undefined;
  return { tokens, commits };
}

function parseInteger(value: string): number | undefined {
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
