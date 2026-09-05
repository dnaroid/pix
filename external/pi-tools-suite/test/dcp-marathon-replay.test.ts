import { describe, expect, test } from "bun:test";
import type { DcpConfig } from "../src/dcp/config.js";
import { createAutoCompressionBlock } from "../src/dcp/auto-compress.js";
import { applyPruning, detectEmergencyCompressionCandidate } from "../src/dcp/pruner.js";
import { createState, restoreState, serializeState } from "../src/dcp/state.js";
import { estimateMessageTokens } from "../src/dcp/pruner-metadata.js";
import { reconcileInheritedCompressionBlocks } from "../src/dcp/pruner-compression-blocks.js";

function replayConfig(): DcpConfig {
  return {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: true },
    compress: {
      maxContextPercent: 0.65,
      minContextPercent: 0.4,
      modelMaxContextPercent: {},
      modelMinContextPercent: {},
      summaryBuffer: true,
      nudgeFrequency: 2,
      iterationNudgeThreshold: 8,
      nudgeForce: "soft",
      protectedTools: ["compress", "write", "edit"],
      protectTags: true,
      protectUserMessages: true,
      autoCandidates: {
        enabled: true,
        minContextPercent: 0.1,
        keepRecentTurns: 1,
        minMessages: 2,
        minTokens: 500,
      },
      messageMode: {
        enabled: false,
        minContextPercent: 0.1,
        keepRecentTurns: 1,
        mediumTokens: 500,
        highTokens: 5000,
        maxSuggestions: 5,
      },
      autoCompress: {
        enabled: true,
        patience: 0,
        summarizerModel: [],
        timeoutMs: 1000,
      },
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
      autoToolPruning: {
        enabled: false,
        maxOutputTokens: 1200,
        keepRecentTurns: 1,
        readLikeTools: ["read"],
        readLikeTurns: 3,
        protectedTools: [],
      },
      emergencyCurrentTurnPruning: {
        enabled: true,
        hardContextPercent: 0.82,
        targetContextPercent: 0.7,
        patience: 0,
        keepRecentToolPairs: 8,
        minOutputTokens: 100,
        maxSuggestions: 8,
        protectedTools: [],
      },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
    modelOverrides: {},
  };
}

function user(text: string, timestamp: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function toolCall(id: string, timestamp: number): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", input: { path: `/repo/${id}.txt` } }],
    timestamp,
  };
}

function toolResult(id: string, marker: string, timestamp: number): any {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: `${marker}\n${"x".repeat(2_000)}` }],
    timestamp,
  };
}

function renderedText(messages: any[]): string {
  return messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("\n");
}

function projectedTokens(messages: any[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

describe("DCP marathon replay", () => {
  test("one user turn sustains 10 useful auto rollups across 1000 tool groups and restart", async () => {
    const cfg = replayConfig();
    const state = createState();
    const raw: any[] = [user(
      "ACTIVE_CONSTRAINT_KEEP_API_STABLE. NEXT_STEP_CONTINUE_IMPLEMENTATION. <protect>DO_NOT_CHANGE_PUBLIC_API</protect>",
      1,
    )];
    let timestamp = 10;
    let totalGroups = 0;
    let previousProjectedTokens = 0;
    const gains: number[] = [];
    const summarySizes: number[] = [];

    for (let cycle = 0; cycle < 10; cycle++) {
      for (let local = 0; local < 100; local++) {
        const index = totalGroups++;
        const id = `marathon-${index}`;
        raw.push(toolCall(id, timestamp++));
        raw.push(toolResult(id, `RAW_GROUP_${index}`, timestamp++));
      }

      // Every result except the live tail has completed provider evidence by
      // the next planning point. This remains a single user turn throughout.
      const visibleCutoff = Math.max(0, totalGroups - cfg.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs);
      for (let index = 0; index < visibleCutoff; index++) state.providerSeenToolIds.add(`marathon-${index}`);

      const before = applyPruning(raw, state, cfg);
      const beforeTokens = projectedTokens(before);
      if (cycle > 0) {
        // New work may raise the projection between cycles, but the previous
        // commit must have left a bounded rollup rather than recursively
        // reproducing all prior raw output.
        expect(beforeTokens).toBeLessThan(previousProjectedTokens + 80_000);
      }

      const candidate = detectEmergencyCompressionCandidate(
        before,
        state,
        cfg,
        0.90,
        0.65,
        { requiredSavingsTokens: 22_000 },
      );
      expect(candidate).not.toBe(null);
      expect(candidate?.reason).toContain("provider-evidenced prefix");

      const result = await createAutoCompressionBlock({
        candidate: candidate!,
        topic: `Marathon rollup ${cycle + 1}`,
        state,
        config: cfg,
        messages: before,
        requiredGainTokens: 1_000,
      });
      expect(result.projectedGain).toBeGreaterThanOrEqual(1_000);
      gains.push(result.projectedGain);

      const after = applyPruning(raw, state, cfg);
      const afterTokens = projectedTokens(after);
      expect(afterTokens).toBeLessThan(beforeTokens);
      expect(state.compressionBlocks.filter((block) => block.active)).toHaveLength(1);
      expect(state.compressionBlocks).toHaveLength(cycle + 1);
      expect(state.compressionBlocks.at(-1)?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(Array.isArray(state.compressionBlocks.at(-1)?.protectedFragments)).toBe(true);

      const text = renderedText(after);
      expect(text).toContain("ACTIVE_CONSTRAINT_KEEP_API_STABLE");
      expect(text).toContain("DO_NOT_CHANGE_PUBLIC_API");
      expect(text).toContain(`RAW_GROUP_${totalGroups - 1}`);
      expect(text).not.toContain("RAW_GROUP_0\n");
      // New rollups must not recursively embed previous summaries verbatim.
      expect((text.match(/\[Previously compressed:/g) ?? []).length).toBe(0);

      summarySizes.push(state.compressionBlocks.at(-1)?.summary.length ?? 0);
      previousProjectedTokens = afterTokens;
    }

    expect(totalGroups).toBe(1_000);
    expect(gains).toHaveLength(10);
    expect(gains.every((gain) => gain > 0)).toBe(true);
    // Summary size should be bounded by the extractive record, not grow with
    // the 1000 raw outputs or the number of rollups.
    expect(Math.max(...summarySizes)).toBeLessThan(20_000);

    const serialized = serializeState(state);
    const restored = createState();
    restoreState(restored, serialized);
    const afterRestart = applyPruning(raw, restored, cfg);
    const restartText = renderedText(afterRestart);

    expect(restored.compressionBlocks.filter((block) => block.active)).toHaveLength(1);
    expect(restored.compressionBlocks).toHaveLength(10);
    expect(restartText).toContain("ACTIVE_CONSTRAINT_KEEP_API_STABLE");
    expect(restartText).toContain("DO_NOT_CHANGE_PUBLIC_API");
    expect(restartText).toContain("RAW_GROUP_999");
    expect(restartText).not.toContain("RAW_GROUP_0\n");
    expect(projectedTokens(afterRestart)).toBe(previousProjectedTokens);

    // Fork inside the final rollup: the newest block no longer fits, so the
    // deepest ancestor whose exact raw boundaries are present must reactivate.
    const forkAncestor = restored.compressionBlocks[4]!;
    const forkRaw = raw.filter((message) => message.timestamp <= forkAncestor.endTimestamp);
    const reconciliation = reconcileInheritedCompressionBlocks(forkRaw, restored);
    expect(reconciliation.fittingBlockIds).toContain(forkAncestor.id);
    expect(restored.compressionBlocks.find((block) => block.id === forkAncestor.id)?.active).toBe(true);
    expect(restored.compressionBlocks.slice(5).every((block) => !block.active)).toBe(true);

    const forkProjection = applyPruning(forkRaw, restored, cfg);
    const forkText = renderedText(forkProjection);
    expect(forkText).toContain("ACTIVE_CONSTRAINT_KEEP_API_STABLE");
    expect(forkText).toContain("DO_NOT_CHANGE_PUBLIC_API");
    expect(forkText).not.toContain("RAW_GROUP_0\n");
    expect(restored.compressionBlocks.filter((block) => block.active).map((block) => block.id)).toEqual([forkAncestor.id]);
  }, 30_000);
});
