import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "./acp-client";
import { DCP_CONTEXT_MAP_CELL_COUNT, dcpContextMap, dcpContextVisualization } from "./dcp-context-visualization";

describe("DCP context visualization", () => {
  it("keeps live context, live savings, projection, blocks, and measured gain distinct", () => {
    const status: RuntimeStatus = {
      sessionId: "session-1",
      context: { tokens: 64_000, contextWindow: 200_000, percent: 32 },
      dcpTokensSaved: 24_680,
      dcpStats: [
        "DCP Session Statistics:",
        "  Blocks: 2 active / 1 retired / 3 total",
        "  Input/projection: ~80,000 -> ~48,000 (reduction ~32,000)",
        "  Measured commit gain: 12,000 tokens (2 measured commits)",
      ].join("\n"),
      modelUsageRefresh: "skipped",
    };

    expect(dcpContextVisualization(status)).toMatchObject({
      context: status.context,
      liveTokensSaved: 24_680,
      blocks: { active: 2, retired: 1, total: 3 },
      projection: { raw: 80_000, projected: 48_000 },
      measuredGain: { tokens: 12_000, commits: 2 },
      historyUnavailable: false,
    });
  });

  it("does not turn unknown durable report values into zero", () => {
    const view = dcpContextVisualization({
      sessionId: "session-1",
      dcpStats: "DCP Session Statistics\n\nHistory unavailable: malformed diagnostic/journal records. No zero statistics inferred.",
      modelUsageRefresh: "skipped",
    });

    expect(view.blocks).toBeUndefined();
    expect(view.projection).toBeUndefined();
    expect(view.measuredGain).toBeUndefined();
    expect(view.liveTokensSaved).toBeUndefined();
    expect(view.historyUnavailable).toBe(true);
  });

  it("preserves actual zero-valued durable metrics", () => {
    const view = dcpContextVisualization({
      sessionId: "session-1",
      dcpStats: [
        "Blocks: 0 active / 0 retired / 0 total",
        "Input/projection: ~0 -> ~0 (reduction ~0)",
        "Measured commit gain: 0 tokens (0 measured commits)",
      ].join("\n"),
      modelUsageRefresh: "skipped",
    });

    expect(view.blocks).toEqual({ active: 0, retired: 0, total: 0 });
    expect(view.projection).toEqual({ raw: 0, projected: 0 });
    expect(view.measuredGain).toEqual({ tokens: 0, commits: 0 });
  });

  it("treats unsafe or internally inconsistent block counts as unknown", () => {
    for (const blocks of [
      "Blocks: 2 active / 1 retired / 4 total",
      "Blocks: 9007199254740992 active / 0 retired / 9007199254740992 total",
    ]) {
      expect(dcpContextVisualization({
        sessionId: "session-1",
        dcpStats: blocks,
        modelUsageRefresh: "skipped",
      }).blocks).toBeUndefined();
    }
  });
});

describe("DCP context map", () => {
  const telemetry = (candidate = 10, retained = 30, compressed = 5, protectedTokens = 5) => ({
    revision: 1, sessionEpoch: 0, generatedAt: 1,
    tokenEstimates: { candidate, retained, compressed, protected: protectedTokens },
  });
  const share = (map: ReturnType<typeof dcpContextMap>, kind: string) => map.cells
    .flatMap((cell) => cell.segments).filter((segment) => segment.kind === kind)
    .reduce((sum, segment) => sum + segment.share, 0);

  it("represents zero occupancy with only free cells", () => {
    for (const snapshot of [undefined, telemetry()]) {
      const map = dcpContextMap({ tokens: 0, contextWindow: 200_000, percent: 0 }, snapshot);
      expect(map.occupiedTokens).toBe(0);
      expect(share(map, "free")).toBe(DCP_CONTEXT_MAP_CELL_COUNT);
    }
  });

  it("keeps an unknown context unknown instead of manufacturing free capacity", () => {
    const map = dcpContextMap({ tokens: null, contextWindow: 200_000, percent: null });

    expect(map.occupiedPercent).toBeUndefined();
    expect(share(map, "unknown")).toBe(DCP_CONTEXT_MAP_CELL_COUNT);
    expect(share(map, "free")).toBe(0);
    for (const context of [undefined, { tokens: 1, contextWindow: 0, percent: 0 },
      { tokens: NaN, contextWindow: 100, percent: 0 }, { tokens: -1, contextWindow: 100, percent: 0 }]) {
      expect(dcpContextMap(context, telemetry()).categoryTokens).toBeUndefined();
    }
  });

  it("bounds over-capacity occupancy to the fixed map while retaining the actual percentage", () => {
    const map = dcpContextMap({ tokens: 250, contextWindow: 200, percent: 100 });

    expect(share(map, "occupied")).toBe(DCP_CONTEXT_MAP_CELL_COUNT);
    expect(share(map, "free")).toBe(0);
    expect(map.occupiedPercent).toBe(125);
    const classified = dcpContextMap({ tokens: 250, contextWindow: 200, percent: 100 }, telemetry());
    expect(share(classified, "free")).toBe(0);
    expect(Object.values(classified.categoryTokens!).reduce((a, b) => a + b, 0)).toBe(250);
    expect(classified.cells.flatMap((cell) => cell.segments).reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(40);
  });

  it("preserves fractional capacity in split cells, ignoring reported percent", () => {
    const map = dcpContextMap({ tokens: 33, contextWindow: 100, percent: 99 });
    expect(share(map, "occupied")).toBeCloseTo(13.2);
    expect(share(map, "free")).toBeCloseTo(26.8);
    expect(map.occupiedPercent).toBe(33);
  });

  it("fills occupied content from the top-left and leaves free capacity at the end", () => {
    for (const snapshot of [undefined, telemetry()]) {
      const map = dcpContextMap({ tokens: 52_500, contextWindow: 272_000, percent: 19 }, snapshot);
      const kinds = map.cells.flatMap((cell) => cell.segments.map((segment) => segment.kind));
      expect(kinds[0]).toBe(snapshot ? "retained" : "occupied");
      expect(kinds[kinds.length - 1]).toBe("free");
      const firstFree = kinds.indexOf("free");
      expect(firstFree).toBeGreaterThan(0);
      expect(kinds.slice(firstFree).every((kind) => kind === "free")).toBe(true);
    }
  });

  it("derives a fresh distribution from each pushed context state", () => {
    const before = dcpContextMap({ tokens: 25, contextWindow: 100, percent: 25 });
    const after = dcpContextMap({ tokens: 75, contextWindow: 100, percent: 75 });

    expect(share(before, "occupied")).toBe(10);
    expect(share(after, "occupied")).toBe(30);
  });

  it("allocates unclassified overhead to retained and scales overestimates uniformly", () => {
    const context = { tokens: 100, contextWindow: 200, percent: 50 };
    const small = dcpContextMap(context, telemetry());
    expect(small.categoryTokens).toEqual({ candidate: 10, retained: 80, compressed: 5, protected: 5 });
    expect(small.estimatesScaled).toBe(false);
    const large = dcpContextMap(context, telemetry(40, 120, 20, 20));
    expect(large.categoryTokens).toEqual({ candidate: 20, retained: 60, compressed: 10, protected: 10 });
    expect(large.estimatesScaled).toBe(true);
    expect(share(small, "free")).toBe(share(large, "free"));
  });

  it("preserves tiny categories rather than rounding them to zero", () => {
    const map = dcpContextMap({ tokens: 100, contextWindow: 200, percent: 50 }, telemetry(1, 9999, 0, 0));
    expect(map.categoryTokens?.candidate).toBeCloseTo(0.01);
    expect(share(map, "candidate")).toBeGreaterThan(0);
    expect(map.cells).toHaveLength(40);
    for (const cell of map.cells) expect(cell.segments.reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(1);
  });

  it("distinguishes unavailable classification from an actual zero candidate estimate", () => {
    const context = { tokens: 50, contextWindow: 100, percent: 50 };
    expect(dcpContextMap(context).categoryTokens).toBeUndefined();
    expect(dcpContextMap(context, telemetry(0)).categoryTokens?.candidate).toBe(0);
  });
});
